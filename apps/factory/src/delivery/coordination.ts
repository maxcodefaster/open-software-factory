import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { deliveryDelegationInput } from "#change-domain/delivery";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeCommitOperation,
  changeWriter,
  operation as operationTable,
  reviewFeedback,
  ticket,
} from "#db/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";

const DELIVERY_POLICY_KIND = "project.delivery_policy";
const DELIVERY_QUEUE_KIND = "project.delivery_queue";
const deliveryPolicyKey = (id: string) => `${DELIVERY_POLICY_KIND}:${id}`;
const deliveryPolicyActiveKey = (projectID: string) => `${DELIVERY_POLICY_KIND}:${projectID}`;
const deliveryQueueKey = (projectID: string) => `${DELIVERY_QUEUE_KIND}:${projectID}`;
const deliveryQueueChangeKey = (changeID: string) => `${DELIVERY_QUEUE_KIND}.change:${changeID}`;

export async function deliveryDelegationIn(
  sql: DatabaseTransaction,
  projectID: string,
  policyID: string,
) {
  const [policy] = await drizzleTransaction(sql)
    .select({ userID: query<string>`${operationTable.payload}->>'delegatedBy'` })
    .from(operationTable)
    .where(
      and(
        eq(operationTable.id, policyID),
        eq(operationTable.kind, DELIVERY_POLICY_KIND),
        eq(operationTable.scopeType, "project"),
        eq(operationTable.scopeId, projectID),
        eq(operationTable.activeKey, deliveryPolicyActiveKey(projectID)),
        eq(operationTable.state, "active"),
      ),
    )
    .for("share");
  if (!policy?.userID)
    throw new CommandError("forbidden", "Automatic Delivery delegation is no longer active.");
  await projectAuthorityIn(sql, policy.userID, projectID, true);
  await projectDevelopmentAuthorityIn(sql, policy.userID, projectID);
  return policy.userID;
}

export function createDeliveryCoordination(database: ReturnType<typeof createDatabase>) {
  // Current-promotion selection stays in the native view. Both queue operations
  // retain the same unsettled merge/promotion fence.
  const mergeOp = alias(operationTable, "merge_op");
  const unsettledPromotionFor = (op: typeof operationTable | typeof mergeOp) =>
    and(
      eq(op.kind, "delivery.merge"),
      eq(op.scopeType, "change"),
      ne(op.state, "failed"),
      or(
        ne(op.state, "succeeded"),
        isNull(query`promotion.state`),
        ne(query`promotion.state`, "succeeded"),
      ),
    );
  return {
    async claim(projectID: string, changeID: string) {
      const queueKey = deliveryQueueKey(projectID);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await db
          .insert(operationTable)
          .values({
            id: crypto.randomUUID(),
            kind: DELIVERY_QUEUE_KIND,
            scopeType: "project",
            scopeId: projectID,
            idempotencyKey: queueKey,
            activeKey: null,
            state: "idle",
            payload: { projectId: projectID, changeId: null },
          })
          .onConflictDoNothing({ target: operationTable.idempotencyKey });
        const [slot] = await db
          .select({ changeID: query<string | null>`${operationTable.payload}->>'changeId'` })
          .from(operationTable)
          .where(
            and(
              eq(operationTable.kind, DELIVERY_QUEUE_KIND),
              eq(operationTable.scopeType, "project"),
              eq(operationTable.scopeId, projectID),
              eq(operationTable.idempotencyKey, queueKey),
            ),
          )
          .for("update");
        const [promotion] = await db
          .select({ changeID: change.id })
          .from(operationTable)
          .innerJoin(change, eq(query<string>`${change.id}::text`, operationTable.scopeId))
          .leftJoin(
            query`factory.current_promotion promotion`,
            eq(query`promotion.change_id`, change.id),
          )
          .where(and(eq(change.projectId, projectID), unsettledPromotionFor(operationTable)))
          .orderBy(operationTable.id)
          .limit(1);
        if (promotion && promotion.changeID !== changeID) return false;
        if (slot?.changeID && slot.changeID !== changeID) {
          const [blocked] = await db
            .select({ id: change.id })
            .from(change)
            .innerJoin(ticket, eq(ticket.id, change.ticketId))
            .leftJoin(changeAgentSession, eq(changeAgentSession.changeId, change.id))
            .leftJoin(agentTurn, eq(agentTurn.id, changeAgentSession.activeTurnId))
            .leftJoin(changeWriter, eq(changeWriter.changeId, change.id))
            .where(
              and(
                eq(change.id, slot.changeID),
                or(
                  inArray(change.state, ["cancelled", "cancelling", "failed", "delivered"]),
                  isNotNull(ticket.trashedAt),
                  eq(
                    change.deliveryWaitingSha,
                    db
                      .select({ sha: changeCommitOperation.commitSha })
                      .from(changeCommitOperation)
                      .where(
                        and(
                          eq(changeCommitOperation.changeId, change.id),
                          eq(changeCommitOperation.state, "succeeded"),
                        ),
                      )
                      .orderBy(desc(changeCommitOperation.sequence))
                      .limit(1),
                  ),
                  eq(changeAgentSession.stopPending, true),
                  inArray(changeAgentSession.state, ["failed", "stopped", "waiting"]),
                  and(
                    inArray(changeAgentSession.state, ["starting", "working"]),
                    query`${agentTurn.authority}->'review' IS NULL`,
                  ),
                  inArray(changeWriter.state, ["human", "handoff"]),
                  exists(
                    db
                      .select({ id: reviewFeedback.id })
                      .from(reviewFeedback)
                      .where(
                        and(
                          eq(reviewFeedback.changeId, change.id),
                          eq(reviewFeedback.kind, "thread"),
                          ne(reviewFeedback.state, "resolved"),
                        ),
                      ),
                  ),
                ),
              ),
            );
          if (!blocked) return false;
        }
        await db
          .update(operationTable)
          .set({
            activeKey: deliveryQueueChangeKey(changeID),
            state: "active",
            payload: { projectId: projectID, changeId: changeID },
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(operationTable.kind, DELIVERY_QUEUE_KIND),
              eq(operationTable.scopeType, "project"),
              eq(operationTable.scopeId, projectID),
              eq(operationTable.idempotencyKey, queueKey),
              query`(${operationTable.payload}->>'changeId') IS DISTINCT FROM ${changeID}`,
            ),
          );
        return true;
      });
    },
    async release(changeID: string) {
      const changeKey = deliveryQueueChangeKey(changeID);
      await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const [slot] = await db
          .select({ id: operationTable.id, projectID: operationTable.scopeId })
          .from(operationTable)
          .where(
            and(
              eq(operationTable.kind, DELIVERY_QUEUE_KIND),
              eq(operationTable.activeKey, changeKey),
            ),
          )
          .for("update");
        if (!slot) return;
        // A concurrent approval can persist its merge intent while this waits.
        // Check that intent in a fresh statement after acquiring the slot.
        await db
          .update(operationTable)
          .set({
            activeKey: null,
            state: "idle",
            payload: { projectId: slot.projectID, changeId: null },
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(operationTable.id, slot.id),
              eq(operationTable.kind, DELIVERY_QUEUE_KIND),
              eq(operationTable.activeKey, changeKey),
              notExists(
                db
                  .select({ id: mergeOp.id })
                  .from(mergeOp)
                  .leftJoin(
                    query`factory.current_promotion promotion`,
                    eq(query<string>`promotion.change_id::text`, mergeOp.scopeId),
                  )
                  .where(and(eq(mergeOp.scopeId, changeID), unsettledPromotionFor(mergeOp))),
              ),
            ),
          );
      });
    },
    async activePolicy(projectID: string) {
      const [policy] = await database.db
        .select({
          id: operationTable.id,
          userID: query<string>`${operationTable.payload}->>'delegatedBy'`,
        })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, DELIVERY_POLICY_KIND),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, projectID),
            eq(operationTable.activeKey, deliveryPolicyActiveKey(projectID)),
            eq(operationTable.state, "active"),
          ),
        );
      if (!policy?.userID) return null;
      try {
        await database.client.begin((sql) => deliveryDelegationIn(sql, projectID, policy.id));
        return policy;
      } catch (cause) {
        if (cause instanceof CommandError) return null;
        throw cause;
      }
    },
    async settings(projectID: string, userID: string) {
      const canManage = await database.client.begin((sql) =>
        projectAuthorityIn(sql, userID, projectID),
      );
      let canDelegate = canManage;
      try {
        await database.client.begin((sql) => projectDevelopmentAuthorityIn(sql, userID, projectID));
      } catch (cause) {
        if (!(cause instanceof CommandError)) throw cause;
        canDelegate = false;
      }
      const [policy] = await database.db
        .select({
          id: operationTable.id,
          delegatedBy: query<string | null>`${operationTable.payload}->>'delegatedBy'`,
        })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, DELIVERY_POLICY_KIND),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, projectID),
            eq(operationTable.activeKey, deliveryPolicyActiveKey(projectID)),
            eq(operationTable.state, "active"),
          ),
        );
      const active = await this.activePolicy(projectID);
      return {
        policyId: policy?.id ?? null,
        enabled: Boolean(active),
        delegatedBy: policy?.delegatedBy ?? null,
        canManage,
        canDelegate,
      };
    },
    async configure(
      projectID: string,
      userID: string,
      raw: z.input<typeof deliveryDelegationInput>,
    ) {
      const input = deliveryDelegationInput.parse(raw);
      await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`delivery-policy:${projectID}`}))`;
        await projectAuthorityIn(sql, userID, projectID, true);
        if (input.enabled) await projectDevelopmentAuthorityIn(sql, userID, projectID);
        const [current] = await db
          .select({ id: operationTable.id })
          .from(operationTable)
          .where(
            and(
              eq(operationTable.kind, DELIVERY_POLICY_KIND),
              eq(operationTable.scopeType, "project"),
              eq(operationTable.scopeId, projectID),
              eq(operationTable.activeKey, deliveryPolicyActiveKey(projectID)),
              eq(operationTable.state, "active"),
            ),
          )
          .for("update");
        if (input.enabled && current?.id === input.commandId) return;
        if (!input.enabled && !current && input.expectedPolicyId) {
          const [replay] = await db
            .select({ id: operationTable.id })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.id, input.expectedPolicyId),
                eq(operationTable.kind, DELIVERY_POLICY_KIND),
                eq(operationTable.scopeType, "project"),
                eq(operationTable.scopeId, projectID),
                eq(operationTable.state, "revoked"),
                query`${operationTable.payload}->>'revokedCommandId' = ${input.commandId}`,
                query`${operationTable.payload}->>'revokedBy' = ${userID}`,
              ),
            );
          if (replay) return;
        }
        if ((current?.id ?? null) !== input.expectedPolicyId)
          throw new CommandError(
            "conflict",
            "Delivery delegation changed. Refresh before changing it.",
          );
        if (current)
          await db
            .update(operationTable)
            .set({
              activeKey: null,
              state: "revoked",
              payload: query`${operationTable.payload} || jsonb_build_object(
                'revokedAt', to_jsonb(now()),
                'revokedCommandId', ${input.commandId}::text,
                'revokedBy', ${userID}::text
              )`,
              completedAt: query`now()`,
              updatedAt: query`now()`,
            })
            .where(
              and(eq(operationTable.id, current.id), eq(operationTable.kind, DELIVERY_POLICY_KIND)),
            );
        if (input.enabled)
          await db.insert(operationTable).values({
            id: input.commandId,
            kind: DELIVERY_POLICY_KIND,
            scopeType: "project",
            scopeId: projectID,
            idempotencyKey: deliveryPolicyKey(input.commandId),
            activeKey: deliveryPolicyActiveKey(projectID),
            state: "active",
            payload: {
              projectId: projectID,
              delegatedBy: userID,
              revokedAt: null,
              revokedCommandId: null,
              revokedBy: null,
            },
            createdBy: userID,
          });
      });
      return this.settings(projectID, userID);
    },
  };
}
