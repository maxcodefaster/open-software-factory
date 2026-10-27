import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createAgentController } from "../agent/controller";
import { CommandError } from "../command-error";
import type { createChangeController } from "./controller";

// Persisted user commands, not a backlog planner. Ordinary Change admission
// rechecks scope, account, budget, prerequisites and exclusive writing.
export function createImplementationOrders(
  database: ReturnType<typeof createDatabase>,
  changes: Pick<ReturnType<typeof createChangeController>, "start">,
  agent: {
    admitStartIn(
      ...args: Parameters<ReturnType<typeof createAgentController>["admitStartIn"]>
    ): Promise<unknown>;
  },
) {
  let running = false;
  return {
    async reconcile() {
      if (running) return;
      running = true;
      try {
        await database.client`UPDATE factory.implementation_order ordering SET state='cancelled',cancelled_at=now(),updated_at=now()
          FROM factory.ticket ticket WHERE ticket.id=ordering.ticket_id AND ordering.state='waiting'
            AND (ticket.trashed_at IS NOT NULL OR ticket.state IN ('cancelled','done') OR ticket.converted_to_epic_id IS NOT NULL)`;
        const orders = await database.client<
          {
            commandID: string;
            ticketID: string;
            userID: string;
            revisionID: string;
            technicalID: string | null;
            reasoning: CodingReasoning | null;
          }[]
        >`SELECT command_id AS "commandID",ticket_id AS "ticketID",created_by AS "userID",
          requirement_revision_id AS "revisionID",technical_design_revision_id AS "technicalID",coding_reasoning AS reasoning
          FROM factory.implementation_order ordering WHERE state='waiting'
            AND NOT EXISTS(SELECT 1 FROM factory.ticket_prerequisites(ordering.project_id,ordering.ticket_id) WHERE NOT delivered)
          ORDER BY created_at,command_id LIMIT 32`;
        for (const order of orders) {
          try {
            await changes.start(order.ticketID, order.userID, {
              commandID: order.commandID,
              revisionID: order.revisionID,
              ...(order.technicalID ? { technicalDesignRevisionID: order.technicalID } : {}),
              ...(order.reasoning ? { codingReasoning: order.reasoning } : {}),
              admitBuild: (sql, id) =>
                agent.admitStartIn(
                  sql,
                  id,
                  order.userID,
                  order.commandID,
                  order.reasoning ?? undefined,
                ),
            });
          } catch (cause) {
            if (cause instanceof CommandError)
              await database.client`UPDATE factory.implementation_order SET state='blocked',last_error=${cause.message.slice(0, 2000)},updated_at=now()
                WHERE command_id=${order.commandID} AND state='waiting'`;
            else
              await database.client`UPDATE factory.implementation_order
                SET last_error='Implementation start is unconfirmed. Factory will reconcile this retained order.',updated_at=now()
                WHERE command_id=${order.commandID} AND state='waiting'
                  AND last_error IS DISTINCT FROM 'Implementation start is unconfirmed. Factory will reconcile this retained order.'`;
            // External outcomes are recovered by the existing deterministic
            // Change/turn intents. Never invent another command on recovery.
          }
        }
      } finally {
        running = false;
      }
    },
  };
}
