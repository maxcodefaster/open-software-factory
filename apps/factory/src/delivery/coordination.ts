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
import type { z } from "zod";
import { deliveryDelegationInput } from "../../../../packages/change-domain/src/delivery";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeCommitOperation,
  changeWriter,
  mergeOperation,
  projectDeliveryPolicy,
  projectDeliveryQueue,
  reviewFeedback,
  ticket,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

export async function deliveryDelegationIn(
  sql: DatabaseTransaction,
  projectID: string,
  policyID: string,
) {
  const [policy] = await drizzleTransaction(sql)
    .select({ userID: projectDeliveryPolicy.delegatedBy })
    .from(projectDeliveryPolicy)
    .where(
      and(
        eq(projectDeliveryPolicy.id, policyID),
        eq(projectDeliveryPolicy.projectId, projectID),
        isNull(projectDeliveryPolicy.revokedAt),
      ),
    )
    .for("share");
  if (!policy)
    throw new CommandError("forbidden", "Automatic Delivery delegation is no longer active.");
  await projectAuthorityIn(sql, policy.userID, projectID, true);
  await projectDevelopmentAuthorityIn(sql, policy.userID, projectID);
  return policy.userID;
}

export function createDeliveryCoordination(database: ReturnType<typeof createDatabase>) {
  // Current-promotion selection stays in the native view. Both queue operations
  // retain the same unsettled merge/promotion fence.
  const unsettledPromotion = and(
    ne(mergeOperation.state, "failed"),
    or(
      ne(mergeOperation.state, "succeeded"),
      isNull(query`promotion.state`),
      ne(query`promotion.state`, "succeeded"),
    ),
  );
  return {
    async claim(projectID: string, changeID: string) {
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await db
          .insert(projectDeliveryQueue)
          .values({ projectId: projectID })
          .onConflictDoNothing();
        const [slot] = await db
          .select({ changeID: projectDeliveryQueue.changeId })
          .from(projectDeliveryQueue)
          .where(eq(projectDeliveryQueue.projectId, projectID))
          .for("update");
        const [promotion] = await db
          .select({ changeID: mergeOperation.changeId })
          .from(mergeOperation)
          .innerJoin(change, eq(change.id, mergeOperation.changeId))
          .leftJoin(
            query`factory.current_promotion promotion`,
            eq(query`promotion.change_id`, change.id),
          )
          .where(and(eq(change.projectId, projectID), unsettledPromotion))
          .orderBy(mergeOperation.id)
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
          .update(projectDeliveryQueue)
          .set({ changeId: changeID, updatedAt: query`now()` })
          .where(
            and(
              eq(projectDeliveryQueue.projectId, projectID),
              query`${projectDeliveryQueue.changeId} IS DISTINCT FROM ${changeID}::uuid`,
            ),
          );
        return true;
      });
    },
    async release(changeID: string) {
      await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const [slot] = await db
          .select({ projectID: projectDeliveryQueue.projectId })
          .from(projectDeliveryQueue)
          .where(eq(projectDeliveryQueue.changeId, changeID))
          .for("update");
        if (!slot) return;
        // A concurrent approval can persist its merge intent while this waits.
        // Check that intent in a fresh statement after acquiring the slot.
        await db
          .update(projectDeliveryQueue)
          .set({ changeId: null, updatedAt: query`now()` })
          .where(
            and(
              eq(projectDeliveryQueue.changeId, changeID),
              notExists(
                db
                  .select({ id: mergeOperation.id })
                  .from(mergeOperation)
                  .leftJoin(
                    query`factory.current_promotion promotion`,
                    eq(query`promotion.change_id`, mergeOperation.changeId),
                  )
                  .where(and(eq(mergeOperation.changeId, changeID), unsettledPromotion)),
              ),
            ),
          );
      });
    },
    async activePolicy(projectID: string) {
      const [policy] = await database.db
        .select({
          id: projectDeliveryPolicy.id,
          userID: projectDeliveryPolicy.delegatedBy,
        })
        .from(projectDeliveryPolicy)
        .where(
          and(
            eq(projectDeliveryPolicy.projectId, projectID),
            isNull(projectDeliveryPolicy.revokedAt),
          ),
        );
      if (!policy) return null;
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
          id: projectDeliveryPolicy.id,
          delegatedBy: projectDeliveryPolicy.delegatedBy,
        })
        .from(projectDeliveryPolicy)
        .where(
          and(
            eq(projectDeliveryPolicy.projectId, projectID),
            isNull(projectDeliveryPolicy.revokedAt),
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
          .select({ id: projectDeliveryPolicy.id })
          .from(projectDeliveryPolicy)
          .where(
            and(
              eq(projectDeliveryPolicy.projectId, projectID),
              isNull(projectDeliveryPolicy.revokedAt),
            ),
          )
          .for("update");
        if (input.enabled && current?.id === input.commandId) return;
        if (!input.enabled && !current && input.expectedPolicyId) {
          const [replay] = await db
            .select({ id: projectDeliveryPolicy.id })
            .from(projectDeliveryPolicy)
            .where(
              and(
                eq(projectDeliveryPolicy.id, input.expectedPolicyId),
                eq(projectDeliveryPolicy.projectId, projectID),
                eq(projectDeliveryPolicy.revokedCommandId, input.commandId),
                eq(projectDeliveryPolicy.revokedBy, userID),
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
            .update(projectDeliveryPolicy)
            .set({
              revokedAt: query`now()`,
              revokedCommandId: input.commandId,
              revokedBy: userID,
            })
            .where(eq(projectDeliveryPolicy.id, current.id));
        if (input.enabled)
          await db
            .insert(projectDeliveryPolicy)
            .values({ id: input.commandId, projectId: projectID, delegatedBy: userID });
      });
      return this.settings(projectID, userID);
    },
  };
}
