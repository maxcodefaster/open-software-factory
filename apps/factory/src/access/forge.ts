import { and, eq, exists, isNull, notExists, or, sql as typedSQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  accountAccess,
  administrator,
  authUser,
  change as changeTable,
  operation,
  projectMembership,
  project as projectTable,
} from "#db/schema";
import { type createForgejoAccess, forgeUsername } from "#forge/access";

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
      const branchScope = `${projectID}:${branch}`;
      const branchKey = `forge.branch:${branchScope}`;
      await sql`SELECT pg_advisory_lock(hashtextextended(${`forge-branch:${projectID}:${branch}`},0))`;
      await db
        .insert(operation)
        .values({
          id: crypto.randomUUID(),
          kind: "forge.branch",
          scopeType: "project_branch",
          scopeId: branchScope,
          idempotencyKey: branchKey,
          state: "intended",
          payload: { projectId: projectID, branch, writers: [], merger: owner },
        })
        .onConflictDoNothing({ target: operation.idempotencyKey });
      const readiness = alias(operation, "setup_readiness");
      const [setup] = await db
        .select({ id: operation.id })
        .from(operation)
        .where(
          and(
            eq(operation.kind, "projects.repository_intent"),
            eq(operation.scopeType, "project"),
            eq(operation.scopeId, projectID),
            eq(operation.idempotencyKey, `projects.repository_intent:${projectID}`),
            typedSQL`(${operation.payload}->>'kind') = 'import'`,
            eq(operation.state, "committed"),
            notExists(
              db
                .select({ id: readiness.id })
                .from(readiness)
                .where(
                  and(
                    eq(readiness.kind, "projects.setup_readiness"),
                    eq(readiness.scopeType, "project"),
                    eq(readiness.scopeId, projectID),
                    eq(
                      readiness.idempotencyKey,
                      `projects.setup_readiness:${projectID}:configuration`,
                    ),
                    eq(readiness.state, "ready"),
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
        .update(operation)
        .set({
          state: "confirmed",
          result: { confirmed: true },
          completedAt: typedSQL`now()`,
          updatedAt: typedSQL`now()`,
        })
        .where(
          and(
            eq(operation.idempotencyKey, branchKey),
            typedSQL`${operation.payload}->'writers' = '[]'::jsonb`,
            typedSQL`${operation.payload}->>'merger' = ${owner}`,
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
        const branchScope = `${change.projectID}:${change.branch}`;
        const branchKey = `forge.branch:${branchScope}`;
        key = `forge-branch:${branchScope}`;
        await sql`SELECT pg_advisory_lock(hashtextextended(${key},0))`;
        await db
          .insert(operation)
          .values({
            id: crypto.randomUUID(),
            kind: "forge.branch",
            scopeType: "project_branch",
            scopeId: branchScope,
            idempotencyKey: branchKey,
            state: "intended",
            payload: {
              projectId: change.projectID,
              branch: change.branch,
              writers: [...writers],
              merger: owner,
            },
          })
          .onConflictDoUpdate({
            target: operation.idempotencyKey,
            set: {
              state: "intended",
              payload: typedSQL`jsonb_set(${operation.payload}, '{writers}', ${JSON.stringify([...writers])}::jsonb)`,
              result: null,
              error: null,
              completedAt: null,
              updatedAt: typedSQL`now()`,
            },
          });
        await forge.protectBranch({
          owner,
          repository: change.repository,
          branch: change.branch,
          writers,
          merger: owner,
        });
        await db
          .update(operation)
          .set({
            state: "confirmed",
            result: { confirmed: true },
            completedAt: typedSQL`now()`,
            updatedAt: typedSQL`now()`,
          })
          .where(eq(operation.idempotencyKey, branchKey));
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
          sourceID: typedSQL<number>`(${operation.payload}->>'sourceId')::integer`,
        })
        .from(operation)
        .where(
          and(
            eq(operation.kind, "access.forge_connection"),
            eq(operation.idempotencyKey, "access.forge_connection:singleton"),
            eq(operation.state, "ready"),
          ),
        );
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
        const accountKey = `forge.account:${userID}`;
        const username = forgeUsername(userID);
        const [previous] = await db
          .select({ id: operation.id })
          .from(operation)
          .where(eq(operation.activeKey, accountKey));
        if (!person.allowed && !previous) return;
        await db
          .insert(operation)
          .values({
            id: crypto.randomUUID(),
            kind: "forge.account",
            scopeType: "user",
            scopeId: userID,
            idempotencyKey: `forge.account:${username}`,
            activeKey: accountKey,
            state: "create-intended",
            payload: { username, sourceId: connection.sourceID },
          })
          .onConflictDoNothing();
        const [intended] = await db
          .select({ payload: operation.payload })
          .from(operation)
          .where(eq(operation.activeKey, accountKey));
        if (
          intended?.payload["username"] !== username ||
          intended?.payload["sourceId"] !== connection.sourceID
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
          const grantScope = `${project.id}:${userID}`;
          const grantKey = `forge.grant:${grantScope}`;
          await db
            .insert(operation)
            .values({
              id: crypto.randomUUID(),
              kind: "forge.grant",
              scopeType: "project_user",
              scopeId: grantScope,
              idempotencyKey: grantKey,
              state: "intended",
              payload: { projectId: project.id, userId: userID, desired: project.grant },
            })
            .onConflictDoUpdate({
              target: operation.idempotencyKey,
              set: {
                state: "intended",
                payload: { projectId: project.id, userId: userID, desired: project.grant },
                result: null,
                error: null,
                completedAt: null,
                updatedAt: typedSQL`now()`,
              },
            });
          if (project.grant) await protectMain(project.id, project.slug, project.branch);
          await forge.repositoryGrant(owner, project.slug, userID, project.grant);
          await db
            .update(operation)
            .set({
              state: "confirmed",
              result: typedSQL`jsonb_build_object('confirmed', ${operation.payload}->'desired')`,
              completedAt: typedSQL`now()`,
              updatedAt: typedSQL`now()`,
            })
            .where(
              and(
                eq(operation.idempotencyKey, grantKey),
                typedSQL`${operation.payload}->'desired' = ${JSON.stringify(project.grant)}::jsonb`,
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
          SELECT 1 FROM factory.project project
          JOIN factory.operation intent
            ON intent.kind='forge.grant'
           AND intent.scope_type='project_user'
           AND intent.idempotency_key='forge.grant:' || project.id::text || ':' || ${userID}
          WHERE intent.payload->'desired' IS DISTINCT FROM to_jsonb(
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
            .update(operation)
            .set({
              state: person.allowed ? "ready" : "disabled",
              result: { forgeUserId: observedID ?? null },
              completedAt: typedSQL`now()`,
              updatedAt: typedSQL`now()`,
            })
            .where(eq(operation.activeKey, accountKey));
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
