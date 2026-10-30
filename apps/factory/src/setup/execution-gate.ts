import type { Sql, TransactionSql } from "postgres";
import { CommandError } from "../command-error";

export async function requireSetupReady(sql: Sql | TransactionSql, projectID: string) {
  const [blocked] = await sql`SELECT project.id FROM factory.project project
    LEFT JOIN factory.project_repository_intent intent ON intent.project_id=project.id
    LEFT JOIN factory.project_setup_readiness readiness ON readiness.project_id=project.id AND readiness.task='configuration'
    WHERE project.id=${projectID} AND (intent.kind='import' OR readiness.project_id IS NOT NULL)
      AND readiness.state IS DISTINCT FROM 'ready'`;
  if (blocked)
    throw new CommandError(
      "unavailable",
      "Confirm this Project's configuration before starting its environment. Planning is available.",
    );
}
