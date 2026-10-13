import type { createDatabase } from "../../../../packages/db/src/client";

export function createAccountRevocation(options: {
  database: ReturnType<typeof createDatabase>;
  sweepRuntime: () => Promise<void>;
  reconcileEditor: (userID: string) => Promise<void>;
  reconcileSources: (userID: string) => Promise<void>;
  stopRuntime: (attemptID: string) => Promise<unknown>;
  stopAgent: (changeID: string) => Promise<unknown>;
  reconcileForge: (userID: string) => Promise<unknown>;
}) {
  return async (userID: string, disabled: boolean) => {
    await options.sweepRuntime();
    // Forge reconciliation may remain pending and be retried. Only lost
    // authority invalidates newly opened editing access on those retries.
    await options.reconcileEditor(userID);
    await options.reconcileSources(userID);
    const humanWork = await options.database.client<{ attemptID: string }[]>`
      SELECT change.runtime_attempt_id AS "attemptID" FROM factory.change_writer writer
      JOIN factory.change change ON change.id=writer.change_id
      WHERE writer.user_id=${userID} AND change.runtime_attempt_id IS NOT NULL
        AND (${disabled} OR NOT EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID})
          AND NOT EXISTS(SELECT 1 FROM factory.project_membership WHERE project_id=change.project_id AND user_id=${userID} AND role='developer'))`;
    for (const work of humanWork) await options.stopRuntime(work.attemptID);
    const changes = await options.database.client<Array<{ id: string }>>`
      SELECT DISTINCT turn.change_id AS id FROM factory.agent_turn turn
      JOIN factory.change change ON change.id=turn.change_id
      WHERE turn.created_by=${userID} AND turn.state IN ('pending','dispatching','running','uncertain')
        AND (${disabled} OR NOT EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID})
          AND NOT EXISTS(SELECT 1 FROM factory.project_membership WHERE project_id=change.project_id AND user_id=${userID}))`;
    for (const change of changes) await options.stopAgent(change.id);
    await options.reconcileForge(userID);
  };
}
