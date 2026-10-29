import type { createDatabase } from "../../../../packages/db/src/client";
import { createAgentTurnStore } from "../agent/turn-store";
import { createUsageJournal } from "../usage/journal";

type Database = ReturnType<typeof createDatabase>;

export async function installationInMaintenance(database: Database) {
  const [state] = await database.client<{ enabled: boolean }[]>`
    SELECT enabled FROM factory.installation_maintenance WHERE singleton`;
  if (!state) throw new Error("Installation maintenance state is unavailable");
  return state.enabled;
}

export async function beginInstallationMaintenance(database: Database) {
  // Older processes could leave a dispatched Project turn behind after losing
  // its lease. Reconcile only that already-expired Project execution, through
  // the normal recovery boundary. This neither retries inference nor stops a
  // live owner. The fenced admission check below still rejects all active work.
  const expired = await database.client<{ id: string }[]>`
    SELECT id FROM factory.agent_turn WHERE change_id IS NULL
      AND state IN ('dispatching','running')
      AND (owner_token IS NULL OR owner_expires_at<=clock_timestamp())`;
  const turns = createAgentTurnStore(database);
  const usage = createUsageJournal(database);
  for (const { id } of expired)
    if (await turns.quarantineExpiredProject(id)) await usage.abandon(`turn:${id}`);
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
