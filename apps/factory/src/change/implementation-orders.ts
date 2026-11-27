import { and, asc, eq, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";
import type { CodingReasoning } from "#conversation-domain/model-settings";
import type { createDatabase } from "#db/client";
import { operation, ticket } from "#db/schema";
import type { createAgentController } from "../agent/api";
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
          .update(operation)
          .set({
            state: "cancelled",
            activeKey: null,
            completedAt: sql<Date>`now()`,
            payload: sql`${operation.payload} || jsonb_build_object('cancelledAt', to_jsonb(now()))`,
            updatedAt: sql<Date>`now()`,
          })
          .from(ticket)
          .where(
            and(
              eq(operation.kind, "tickets.implementation_order"),
              eq(operation.scopeType, "ticket"),
              eq(sql`${ticket.id}::text`, operation.scopeId),
              eq(operation.state, "waiting"),
              or(
                isNotNull(ticket.trashedAt),
                inArray(ticket.state, ["cancelled", "done"]),
                isNotNull(ticket.convertedToEpicId),
              ),
            ),
          );
        const orders = await db
          .select({
            commandID: operation.id,
            ticketID: sql<string>`(${operation.scopeId})::uuid`,
            userID: sql<string>`coalesce(${operation.createdBy}, (${operation.payload}->>'createdBy')::uuid)`,
            revisionID: sql<string>`(${operation.payload}->>'requirementRevisionId')::uuid`,
            technicalID: sql<
              string | null
            >`(${operation.payload}->>'technicalDesignRevisionId')::uuid`,
            reasoning: sql<CodingReasoning | null>`${operation.payload}->>'codingReasoning'`,
          })
          .from(operation)
          .where(
            and(
              eq(operation.kind, "tickets.implementation_order"),
              eq(operation.scopeType, "ticket"),
              eq(operation.state, "waiting"),
              notExists(
                // The existing native routine owns the prerequisite Delivery predicate.
                db
                  .select({ delivered: sql<boolean>`prerequisite.delivered` })
                  .from(
                    sql`factory.ticket_prerequisites((${operation.payload}->>'projectId')::uuid,(${operation.scopeId})::uuid) AS prerequisite`,
                  )
                  .where(sql<boolean>`NOT prerequisite.delivered`),
              ),
            ),
          )
          .orderBy(asc(operation.createdAt), asc(operation.id))
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
            if (cause instanceof CommandError) {
              const message = cause.message.slice(0, 2000);
              await db
                .update(operation)
                .set({
                  state: "blocked",
                  activeKey: null,
                  completedAt: sql<Date>`now()`,
                  error: message,
                  payload: sql`${operation.payload} || ${JSON.stringify({ lastError: message })}::jsonb`,
                  updatedAt: sql<Date>`now()`,
                })
                .where(
                  and(
                    eq(operation.id, order.commandID),
                    eq(operation.kind, "tickets.implementation_order"),
                    eq(operation.state, "waiting"),
                  ),
                );
            } else {
              const unconfirmed =
                "Implementation start is unconfirmed. Factory will reconcile this retained order.";
              await db
                .update(operation)
                .set({
                  error: unconfirmed,
                  payload: sql`${operation.payload} || ${JSON.stringify({ lastError: unconfirmed })}::jsonb`,
                  updatedAt: sql<Date>`now()`,
                })
                .where(
                  and(
                    eq(operation.id, order.commandID),
                    eq(operation.kind, "tickets.implementation_order"),
                    eq(operation.state, "waiting"),
                    sql<boolean>`${operation.error} IS DISTINCT FROM ${unconfirmed}`,
                  ),
                );
            }
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
