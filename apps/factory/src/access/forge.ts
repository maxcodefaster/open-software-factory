import { and, eq, exists, isNull, notExists, or, sql as typedSQL } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  accountAccess,
  administrator,
  authUser,
  change as changeTable,
  forgeAccountIntent,
  forgeBranchIntent,
  forgeConnection,
  forgeGrantIntent,
  projectMembership,
  projectRepositoryIntent,
  projectSetupReadiness,
  project as projectTable,
} from "../../../../packages/db/src/schema";
import { type createForgejoAccess, forgeUsername } from "../../../../packages/forge/src/access";

type Database = ReturnType<typeof createDatabase>;

export function createForgeAccessReconciliation(options: {
  database: Database;
  forge: ReturnType<typeof createForgejoAccess>;
  owner: string;
  origin: string;
  publicOrigin: string;
}) {
  const { database, forge, owner } = options;
  const origins = new Set([new URL(options.origin).origin, new URL(options.publicOrigin).origin]);
  async function protectMain(projectID: string, repository: string, branch: string) {
    const sql = database.coordination();
    const db = drizzleTransaction(sql);
    try {
      await sql`SELECT pg_advisory_lock(hashtextextended(${`forge-branch:${projectID}:${branch}`},0))`;
      await db
        .insert(forgeBranchIntent)
        .values({ projectId: projectID, branch, writers: [], merger: owner })
        .onConflictDoNothing({ target: [forgeBranchIntent.projectId, forgeBranchIntent.branch] });
      const [setup] = await db
        .select({ projectId: projectRepositoryIntent.projectId })
        .from(projectRepositoryIntent)
        .where(
          and(
            eq(projectRepositoryIntent.projectId, projectID),
            eq(projectRepositoryIntent.kind, "import"),
            eq(projectRepositoryIntent.state, "committed"),
            notExists(
              db
                .select({ projectId: projectSetupReadiness.projectId })
                .from(projectSetupReadiness)
                .where(
                  and(
                    eq(projectSetupReadiness.projectId, projectID),
                    eq(projectSetupReadiness.task, "configuration"),
                    eq(projectSetupReadiness.state, "ready"),
                  ),
                ),
            ),
          ),
        )
        .limit(1);
      await forge.protectBranch({
        owner,
        repository,
        branch,
        writers: [],
        merger: owner,
        // Initial setup owns the missing workflow's exact confirmed creation.
        // Do not race that merge by adding its file rule before setup is ready.
        // Omitting the field preserves existing rules; it never clears protection.
        ...(setup ? {} : { protectedFiles: ".forgejo/workflows/factory-verification.yml" }),
      });
      await db
        .update(forgeBranchIntent)
        .set({ confirmed: true })
        .where(
          and(
            eq(forgeBranchIntent.projectId, projectID),
            eq(forgeBranchIntent.branch, branch),
            eq(forgeBranchIntent.writers, []),
            eq(forgeBranchIntent.merger, owner),
          ),
        );
    } finally {
      try {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${`forge-branch:${projectID}:${branch}`},0))`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  }
  return {
    async protectChange(changeID: string, writers: readonly string[]) {
      const sql = database.coordination();
      const db = drizzleTransaction(sql);
      let key: string | undefined;
      try {
        const [change] = await db
          .select({
            projectID: changeTable.projectId,
            repository: projectTable.slug,
            branch: changeTable.branchName,
          })
          .from(changeTable)
          .innerJoin(projectTable, eq(projectTable.id, changeTable.projectId))
          .where(eq(changeTable.id, changeID));
        if (!change) throw new Error("Forge Change branch is unavailable");
        key = `forge-branch:${change.projectID}:${change.branch}`;
        await sql`SELECT pg_advisory_lock(hashtextextended(${key},0))`;
        await db
          .insert(forgeBranchIntent)
          .values({
            projectId: change.projectID,
            branch: change.branch,
            writers: [...writers],
            merger: owner,
          })
          .onConflictDoUpdate({
            target: [forgeBranchIntent.projectId, forgeBranchIntent.branch],
            set: { writers: [...writers], confirmed: false, updatedAt: typedSQL`now()` },
          });
        await forge.protectBranch({
          owner,
          repository: change.repository,
          branch: change.branch,
          writers,
          merger: owner,
        });
        await db
          .update(forgeBranchIntent)
          .set({ confirmed: true })
          .where(
            and(
              eq(forgeBranchIntent.projectId, change.projectID),
              eq(forgeBranchIntent.branch, change.branch),
            ),
          );
      } finally {
        try {
          if (key) await sql`SELECT pg_advisory_unlock(hashtextextended(${key},0))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
    async reconcile(userID: string) {
      const [connection] = await database.db
        .select({
          sourceID: typedSQL<number>`${forgeConnection.sourceId}::integer`,
        })
        .from(forgeConnection)
        .where(eq(forgeConnection.state, "ready"));
      if (!connection) return;
      const sql = database.coordination();
      const db = drizzleTransaction(sql);
      try {
        await sql`SELECT pg_advisory_lock(hashtextextended(${`forge-account:${userID}`},0))`;
        const systemManager = exists(
          db
            .select({ userId: administrator.userId })
            .from(administrator)
            .where(eq(administrator.userId, userID)),
        );
        const [person] = await db
          .select({
            email: authUser.email,
            name: authUser.name,
            allowed: typedSQL<boolean>`${and(
              isNull(accountAccess.disabledAt),
              isNull(accountAccess.directoryDisabledAt),
              or(
                systemManager,
                exists(
                  db
                    .select({ userId: projectMembership.userId })
                    .from(projectMembership)
                    .where(
                      and(
                        eq(projectMembership.userId, userID),
                        eq(projectMembership.role, "developer"),
                      ),
                    ),
                ),
              ),
            )}`,
          })
          .from(authUser)
          .innerJoin(accountAccess, eq(accountAccess.userId, authUser.id))
          .where(eq(authUser.id, userID));
        if (!person) throw new Error("Factory account access is unavailable");
        const [previous] = await db
          .select({ userId: forgeAccountIntent.userId })
          .from(forgeAccountIntent)
          .where(eq(forgeAccountIntent.userId, userID));
        if (!person.allowed && !previous) return;
        await db
          .insert(forgeAccountIntent)
          .values({
            userId: userID,
            username: forgeUsername(userID),
            sourceId: connection.sourceID,
            state: "create-intended",
          })
          .onConflictDoNothing();
        const [intended] = await db
          .select({
            username: forgeAccountIntent.username,
            sourceID: typedSQL<number>`${forgeAccountIntent.sourceId}::integer`,
          })
          .from(forgeAccountIntent)
          .where(eq(forgeAccountIntent.userId, userID));
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
        const everyProject = await db
          .select({
            id: projectTable.id,
            slug: projectTable.slug,
            repositoryURL: projectTable.repositoryUrl,
            branch: projectTable.defaultBranch,
            grant: typedSQL<boolean>`${person.allowed} and ${or(
              systemManager,
              exists(
                db
                  .select({ userId: projectMembership.userId })
                  .from(projectMembership)
                  .where(
                    and(
                      eq(projectMembership.projectId, projectTable.id),
                      eq(projectMembership.userId, userID),
                      eq(projectMembership.role, "developer"),
                    ),
                  ),
              ),
            )}`,
          })
          .from(projectTable)
          .orderBy(projectTable.id);
        // A Project hosted elsewhere has no repository here to grant on. It must not stop the
        // grants of the Projects that are.
        const projects = everyProject.filter((project) =>
          origins.has(new URL(project.repositoryURL).origin),
        );
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
              !origins.has(repository.origin) ||
              repository.pathname.replace(/\.git$/, "") !== `/${owner}/${project.slug}`)
          )
            throw new Error("Factory Project repository differs from its recorded forge identity");
          await db
            .insert(forgeGrantIntent)
            .values({ projectId: project.id, userId: userID, desired: project.grant })
            .onConflictDoUpdate({
              target: [forgeGrantIntent.projectId, forgeGrantIntent.userId],
              set: { desired: project.grant, confirmed: null, updatedAt: typedSQL`now()` },
            });
          if (project.grant) await protectMain(project.id, project.slug, project.branch);
          await forge.repositoryGrant(owner, project.slug, userID, project.grant);
          await db
            .update(forgeGrantIntent)
            .set({ confirmed: forgeGrantIntent.desired })
            .where(
              and(
                eq(forgeGrantIntent.projectId, project.id),
                eq(forgeGrantIntent.userId, userID),
                eq(forgeGrantIntent.desired, project.grant),
              ),
            );
        }
        // Final enablement is ordered against account disablement and membership mutations.
        await database.client.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
          const db = drizzleTransaction(transaction);
          await db
            .select({ userId: accountAccess.userId })
            .from(accountAccess)
            .where(eq(accountAccess.userId, userID))
            .for("share");
          await db
            .select({ userId: projectMembership.userId })
            .from(projectMembership)
            .where(eq(projectMembership.userId, userID))
            .for("share");
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
          await db
            .update(forgeAccountIntent)
            .set({
              forgeUserId: observedID ?? null,
              state: person.allowed ? "ready" : "disabled",
              observedAt: typedSQL`now()`,
            })
            .where(eq(forgeAccountIntent.userId, userID));
        });
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtextextended(${`forge-account:${userID}`},0))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
  };
}
