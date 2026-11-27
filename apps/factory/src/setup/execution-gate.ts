import { and, eq, isNotNull, or, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Sql, TransactionSql } from "postgres";
import { drizzleTransaction } from "#db/client";
import { operation, project } from "#db/schema";
import { CommandError } from "../command-error";

export async function requireSetupReady(sql: Sql | TransactionSql, projectID: string) {
  const repoIntent = alias(operation, "repo_intent");
  const readiness = alias(operation, "setup_readiness");
  const [blocked] = await drizzleTransaction(sql)
    .select({ id: project.id })
    .from(project)
    .leftJoin(
      repoIntent,
      and(
        eq(repoIntent.kind, "projects.repository_intent"),
        eq(repoIntent.scopeType, "project"),
        eq(
          repoIntent.idempotencyKey,
          query<string>`'projects.repository_intent:' || ${project.id}::text`,
        ),
      ),
    )
    .leftJoin(
      readiness,
      and(
        eq(readiness.kind, "projects.setup_readiness"),
        eq(readiness.scopeType, "project"),
        eq(
          readiness.idempotencyKey,
          query<string>`'projects.setup_readiness:' || ${project.id}::text || ':configuration'`,
        ),
      ),
    )
    .where(
      and(
        eq(project.id, projectID),
        or(query`(${repoIntent.payload}->>'kind') = 'import'`, isNotNull(readiness.id)),
        query`${readiness.state} IS DISTINCT FROM 'ready'`,
      ),
    );
  if (blocked)
    throw new CommandError(
      "unavailable",
      "Confirm this Project's configuration before starting its environment. Planning is available.",
    );
}
