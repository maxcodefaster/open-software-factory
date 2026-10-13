import type { createDatabase } from "../../../../packages/db/src/client";
import { type createForgejoAccess, forgeUsername } from "../../../../packages/forge/src/access";

type Database = ReturnType<typeof createDatabase>;

export function createForgeAccessReconciliation(options: {
  database: Database;
  forge: ReturnType<typeof createForgejoAccess>;
  owner: string;
  origin?: string;
}) {
  const { database, forge, owner } = options;
  async function protectMain(projectID: string, repository: string, branch: string) {
    const sql = await database.client.reserve();
    try {
      await sql`SELECT pg_advisory_lock(hashtextextended(${`forge-branch:${projectID}:${branch}`},0))`;
      await sql`INSERT INTO factory.forge_branch_intent(project_id,branch,writers,merger)
        VALUES(${projectID},${branch},'{}',${owner}) ON CONFLICT(project_id,branch) DO NOTHING`;
      await forge.protectBranch({
        owner,
        repository,
        branch,
        writers: [],
        merger: owner,
        protectedFiles: ".forgejo/workflows/factory-verification.yml",
      });
      await sql`UPDATE factory.forge_branch_intent SET confirmed=true WHERE project_id=${projectID} AND branch=${branch} AND writers='{}' AND merger=${owner}`;
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${`forge-branch:${projectID}:${branch}`},0))`;
      sql.release();
    }
  }
  return {
    async protectChange(changeID: string, writers: readonly string[]) {
      const [change] = await database.client<
        { projectID: string; repository: string; branch: string }[]
      >`
        SELECT change.project_id AS "projectID",project.slug AS repository,change.branch_name AS branch
        FROM factory.change change JOIN factory.project project ON project.id=change.project_id WHERE change.id=${changeID}`;
      if (!change) throw new Error("Forge Change branch is unavailable");
      const key = `forge-branch:${change.projectID}:${change.branch}`;
      const sql = await database.client.reserve();
      try {
        await sql`SELECT pg_advisory_lock(hashtextextended(${key},0))`;
        await sql`INSERT INTO factory.forge_branch_intent(project_id,branch,writers,merger)
          VALUES(${change.projectID},${change.branch},${sql.array([...writers])},${owner})
          ON CONFLICT(project_id,branch) DO UPDATE SET writers=EXCLUDED.writers,confirmed=false,updated_at=now()`;
        await forge.protectBranch({
          owner,
          repository: change.repository,
          branch: change.branch,
          writers,
          merger: owner,
        });
        await sql`UPDATE factory.forge_branch_intent SET confirmed=true WHERE project_id=${change.projectID} AND branch=${change.branch}`;
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${key},0))`;
        sql.release();
      }
    },
    async reconcile(userID: string) {
      const [connection] = await database.client<{ sourceID: number }[]>`
        SELECT source_id::integer AS "sourceID" FROM factory.forge_connection WHERE state='ready'`;
      if (!connection) return;
      const sql = await database.client.reserve();
      try {
        await sql`SELECT pg_advisory_lock(hashtextextended(${`forge-account:${userID}`},0))`;
        const [person] = await sql<{ email: string; name: string; allowed: boolean }[]>`
          SELECT person.email,person.name,
            access.disabled_at IS NULL AND access.directory_disabled_at IS NULL
              AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID})
                OR EXISTS(SELECT 1 FROM factory.project_membership WHERE user_id=${userID} AND role='developer')) AS allowed
          FROM auth."user" person JOIN factory.account_access access ON access.user_id=person.id WHERE person.id=${userID}`;
        if (!person) throw new Error("Factory account access is unavailable");
        const [previous] =
          await sql`SELECT user_id FROM factory.forge_account_intent WHERE user_id=${userID}`;
        if (!person.allowed && !previous) return;
        await sql`INSERT INTO factory.forge_account_intent(user_id,username,source_id,state)
          VALUES(${userID},${forgeUsername(userID)},${connection.sourceID},'create-intended') ON CONFLICT DO NOTHING`;
        const [intended] = await sql<{ username: string; sourceID: number }[]>`
          SELECT username,source_id::integer AS "sourceID" FROM factory.forge_account_intent WHERE user_id=${userID}`;
        if (
          intended?.username !== forgeUsername(userID) ||
          intended.sourceID !== connection.sourceID
        )
          throw new Error("Forge account intent changed identity");
        // Disable first, before grant removals. Enabled users remain prohibited until all grants agree.
        const existing = await forge.readAccount(forgeUsername(userID));
        if (existing || person.allowed)
          await forge.ensureAccount({
            userID,
            sourceID: connection.sourceID,
            ...person,
            enabled: false,
            suspended: person.allowed,
          });
        const projects = await sql<
          { id: string; slug: string; repositoryURL: string; branch: string; grant: boolean }[]
        >`
          SELECT project.id,project.slug,project.repository_url AS "repositoryURL",project.default_branch AS branch,
            ${person.allowed} AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID})
              OR EXISTS(SELECT 1 FROM factory.project_membership WHERE project_id=project.id AND user_id=${userID} AND role='developer')) AS grant
          FROM factory.project project ORDER BY project.id`;
        await forge.removeAlternativeGrants(
          userID,
          projects
            .filter((project) => project.grant)
            .map((project) => ({ owner, name: project.slug })),
        );
        for (const project of projects) {
          const repository = new URL(project.repositoryURL);
          if (
            project.grant &&
            (repository.username ||
              repository.password ||
              repository.search ||
              repository.hash ||
              (options.origin && repository.origin !== options.origin) ||
              repository.pathname !== `/${owner}/${project.slug}.git`)
          )
            throw new Error("Factory Project repository differs from its recorded forge identity");
          await sql`INSERT INTO factory.forge_grant_intent(project_id,user_id,desired)
            VALUES(${project.id},${userID},${project.grant}) ON CONFLICT(project_id,user_id)
            DO UPDATE SET desired=EXCLUDED.desired,confirmed=NULL,updated_at=now()`;
          if (project.grant) await protectMain(project.id, project.slug, project.branch);
          await forge.repositoryGrant(owner, project.slug, userID, project.grant);
          await sql`UPDATE factory.forge_grant_intent SET confirmed=desired WHERE project_id=${project.id} AND user_id=${userID} AND desired=${project.grant}`;
        }
        // Final enablement is ordered against account disablement and membership mutations.
        await database.client.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
          await transaction`SELECT user_id FROM factory.account_access WHERE user_id=${userID} FOR SHARE`;
          await transaction`SELECT user_id FROM factory.project_membership WHERE user_id=${userID} FOR SHARE`;
          const [current] = await transaction<
            { same: boolean; allowed: boolean }[]
          >`SELECT NOT EXISTS(
          SELECT 1 FROM factory.forge_grant_intent intent JOIN factory.project project ON project.id=intent.project_id
          WHERE intent.user_id=${userID} AND intent.desired IS DISTINCT FROM (
            EXISTS(SELECT 1 FROM factory.account_access WHERE user_id=${userID} AND disabled_at IS NULL AND directory_disabled_at IS NULL)
            AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID}) OR EXISTS(SELECT 1 FROM factory.project_membership WHERE project_id=project.id AND user_id=${userID} AND role='developer')))) AS same,
          EXISTS(SELECT 1 FROM factory.account_access WHERE user_id=${userID} AND disabled_at IS NULL AND directory_disabled_at IS NULL)
            AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID}) OR EXISTS(SELECT 1 FROM factory.project_membership WHERE user_id=${userID} AND role='developer')) AS allowed`;
          if (!current?.same || current.allowed !== person.allowed)
            throw new Error("Forge permissions changed during reconciliation");
          const observedID = await forge.ensureAccount({
            userID,
            sourceID: connection.sourceID,
            ...person,
            enabled: person.allowed,
          });
          await transaction`UPDATE factory.forge_account_intent SET forge_user_id=${observedID ?? null},state=${person.allowed ? "ready" : "disabled"},observed_at=now() WHERE user_id=${userID}`;
        });
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${`forge-account:${userID}`},0))`;
        sql.release();
      }
    },
  };
}
