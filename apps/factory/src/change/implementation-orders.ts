import { and, asc, eq, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import type { createDatabase } from "../../../../packages/db/src/client";
import { implementationOrder, ticket } from "../../../../packages/db/src/schema";
import { type createAgentController } from "../agent/api";
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
        const db = database.db;
        await db
          .update(implementationOrder)
          .set({ state: "cancelled", cancelledAt: sql<Date>`now()`, updatedAt: sql<Date>`now()` })
          .from(ticket)
          .where(
            and(
              eq(ticket.id, implementationOrder.ticketId),
              eq(implementationOrder.state, "waiting"),
              or(
                isNotNull(ticket.trashedAt),
                inArray(ticket.state, ["cancelled", "done"]),
                isNotNull(ticket.convertedToEpicId),
              ),
            ),
          );
        const orders = await db
          .select({
            commandID: implementationOrder.commandId,
            ticketID: implementationOrder.ticketId,
            userID: implementationOrder.createdBy,
            revisionID: implementationOrder.requirementRevisionId,
            technicalID: implementationOrder.technicalDesignRevisionId,
            reasoning: sql<CodingReasoning | null>`${implementationOrder.codingReasoning}`,
          })
          .from(implementationOrder)
          .where(
            and(
              eq(implementationOrder.state, "waiting"),
              notExists(
                // The existing native routine owns the prerequisite Delivery predicate.
                db
                  .select({ delivered: sql<boolean>`prerequisite.delivered` })
                  .from(
                    sql`factory.ticket_prerequisites(${implementationOrder.projectId},${implementationOrder.ticketId}) AS prerequisite`,
                  )
                  .where(sql<boolean>`NOT prerequisite.delivered`),
              ),
            ),
          )
          .orderBy(asc(implementationOrder.createdAt), asc(implementationOrder.commandId))
          .limit(32);
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
              await db
                .update(implementationOrder)
                .set({
                  state: "blocked",
                  lastError: cause.message.slice(0, 2000),
                  updatedAt: sql<Date>`now()`,
                })
                .where(
                  and(
                    eq(implementationOrder.commandId, order.commandID),
                    eq(implementationOrder.state, "waiting"),
                  ),
                );
            else
              await db
                .update(implementationOrder)
                .set({
                  lastError:
                    "Implementation start is unconfirmed. Factory will reconcile this retained order.",
                  updatedAt: sql<Date>`now()`,
                })
                .where(
                  and(
                    eq(implementationOrder.commandId, order.commandID),
                    eq(implementationOrder.state, "waiting"),
                    sql<boolean>`${implementationOrder.lastError} IS DISTINCT FROM 'Implementation start is unconfirmed. Factory will reconcile this retained order.'`,
                  ),
                );
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
