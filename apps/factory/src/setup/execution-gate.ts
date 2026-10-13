import type { Sql, TransactionSql } from "postgres";
import { CommandError } from "../command-error";

export async function requireSetupReady(sql: Sql | TransactionSql, projectID: string) {
  const [blocked] = await sql`SELECT intent.project_id FROM factory.project_repository_intent intent
    LEFT JOIN factory.project_setup_readiness readiness ON readiness.project_id=intent.project_id AND readiness.task='configuration'
    WHERE intent.project_id=${projectID} AND intent.kind='import' AND readiness.state IS DISTINCT FROM 'ready'`;
  if (blocked)
    throw new CommandError(
      "unavailable",
      "Confirm this Project's configuration before starting its environment. Planning is available.",
    );
}
