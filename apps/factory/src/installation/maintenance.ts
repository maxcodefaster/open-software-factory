import type { createDatabase } from "../../../../packages/db/src/client";

type Database = ReturnType<typeof createDatabase>;

export async function installationInMaintenance(database: Database) {
  const [state] = await database.client<{ enabled: boolean }[]>`
    SELECT enabled FROM factory.installation_maintenance WHERE singleton`;
  if (!state) throw new Error("Installation maintenance state is unavailable");
  return state.enabled;
}

export async function beginInstallationMaintenance(database: Database) {
  await database.client.begin(async (sql) => {
    const [state] = await sql`
      UPDATE factory.installation_maintenance SET enabled=true,requested_at=now()
      WHERE singleton RETURNING singleton`;
    if (!state) throw new Error("Installation maintenance state is unavailable");
    const [work] = await sql<{ active: boolean }[]>`
      SELECT
        EXISTS(SELECT 1 FROM factory.agent_turn WHERE state IN ('pending','dispatching','running')
          OR (change_id IS NOT NULL AND state='uncertain'))
        OR EXISTS(SELECT 1 FROM factory.knowledge_generation WHERE state IN ('pending','running'))
        OR EXISTS(SELECT 1 FROM factory.model_role_probe WHERE state='probing')
        OR EXISTS(SELECT 1 FROM factory.project_setup_inspection WHERE state IN ('inspecting','confirming'))
        OR EXISTS(SELECT 1 FROM factory.change_agent_session WHERE stop_pending)
        OR EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE state NOT IN ('succeeded','failed'))
        AS active`;
    if (work?.active)
      throw new Error(
        "Finish or explicitly stop active and unresolved work before upgrading. The running installation was not changed.",
      );
  });
}

export async function finishInstallationMaintenance(database: Database) {
  await database.client`
    UPDATE factory.installation_maintenance SET enabled=false,requested_at=NULL WHERE singleton`;
}
