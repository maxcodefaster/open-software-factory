import { and, eq, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  auditEvent,
  change as changeModel,
  operation as operationTable,
  runtimeAttempt,
  ticket,
  verification,
} from "#db/schema";
import type { ForgeRepository } from "#forge/contracts";
import type { createForgejoClient } from "#forge/forge";
import type { RuntimeAttemptView } from "../runtime/types";

type PromotionChange = {
  id: string;
  projectID: string;
  ticketID: string;
  userID: string;
  runtimeAttemptID: string | null;
};
export function createDeliveryPromotion(
  database: ReturnType<typeof createDatabase>,
  runtime: {
    startStagingReplacement(id: string, userID: string): Promise<RuntimeAttemptView | null>;
    pause(id: string): Promise<RuntimeAttemptView | null>;
    stop(id: string): Promise<RuntimeAttemptView | null>;
  },
  forge: Pick<ReturnType<typeof createForgejoClient>, "deleteRunner">,
  retireBranch: (id: string) => Promise<void>,
) {
  const bounded = (value: string) => (value.length <= 2000 ? value : `${value.slice(0, 1999)}…`);
  async function reconcilePromotion(change: PromotionChange, repository: ForgeRepository) {
    // The native view selects the current immutable promotion attempt.
    const rows = await database.db
      .select({
        id: query<string>`promotion.id`,
        commitSHA: query<string>`promotion.commit_sha`,
        state: query<string>`promotion.state`,
        lastError: query<string | null>`promotion.last_error`,
        previousAttemptID: query<string | null>`promotion.previous_runtime_attempt_id`,
        replacementAttemptID: query<string | null>`promotion.replacement_runtime_attempt_id`,
        replacementState: runtimeAttempt.state,
        retryActorID: auditEvent.actorId,
      })
      .from(query`factory.current_promotion promotion`)
      .leftJoin(
        auditEvent,
        and(
          eq(auditEvent.id, query`promotion.retry_command_id`),
          eq(auditEvent.kind, "usage.policy_command"),
        ),
      )
      .leftJoin(
        runtimeAttempt,
        eq(runtimeAttempt.id, query`promotion.replacement_runtime_attempt_id`),
      )
      .where(eq(query`promotion.change_id`, change.id));
    const promotion = rows[0];
    if (!promotion || promotion.state === "failed") return;
    if (promotion.state === "succeeded") {
      if (promotion.lastError) await cleanupDelivery(change, repository, promotion);
      return;
    }
    if (!promotion.replacementAttemptID) {
      await runtime.startStagingReplacement(promotion.id, promotion.retryActorID ?? change.userID);
      return;
    }
    if (["failed", "stopped", "cleanup-failed"].includes(promotion.replacementState ?? "")) {
      await database.db
        .update(operationTable)
        .set({
          state: "failed",
          activeKey: null,
          error: "Replacement Staging failed before readiness",
          completedAt: query`now()`,
          updatedAt: query`now()`,
        })
        .where(
          and(eq(operationTable.id, promotion.id), eq(operationTable.kind, "delivery.promotion")),
        );
      return;
    }
    if (promotion.replacementState !== "ready") return;
    await database.client.begin(async (transaction) => {
      const db = drizzleTransaction(transaction);
      await db
        .update(operationTable)
        .set({ state: "switching", updatedAt: query`now()` })
        .where(
          and(
            eq(operationTable.id, promotion.id),
            eq(operationTable.kind, "delivery.promotion"),
            eq(operationTable.state, "starting"),
          ),
        );
      await db
        .update(operationTable)
        .set({
          state: promotion.replacementAttemptID ? "attached" : "pending",
          payload: query`jsonb_build_object(
            'projectId', ${change.projectID}::text,
            'revision', ${promotion.commitSHA}::text,
            'runtimeAttemptId', ${promotion.replacementAttemptID}::text
          )`,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(operationTable.kind, "delivery.staging_preview"),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, change.projectID),
            eq(operationTable.idempotencyKey, `delivery.staging_preview:${change.projectID}`),
          ),
        );
      await db
        .update(operationTable)
        .set({
          state: "succeeded",
          activeKey: null,
          completedAt: query`now()`,
          updatedAt: query`now()`,
          error: "Delivery cleanup pending",
        })
        .where(
          and(eq(operationTable.id, promotion.id), eq(operationTable.kind, "delivery.promotion")),
        );
      await db
        .update(changeModel)
        .set({
          state: "delivered",
          cancelRequestedAt: query`now()`,
          failure: null,
          version: query`${changeModel.version} + 1`,
        })
        .where(eq(changeModel.id, change.id));
      await db
        .update(ticket)
        .set({ state: "done", version: query`${ticket.version} + 1`, updatedAt: query`now()` })
        .where(eq(ticket.id, change.ticketID));
    });
    await cleanupDelivery(change, repository, promotion);
  }

  async function cleanupDelivery(
    change: PromotionChange,
    repository: ForgeRepository,
    promotion: { id: string; previousAttemptID: string | null },
  ) {
    try {
      if (promotion.previousAttemptID) await runtime.stop(promotion.previousAttemptID);
      if (change.runtimeAttemptID) await runtime.pause(change.runtimeAttemptID);
      const verifications = await database.db
        .select({
          runtimeAttemptID: verification.runtimeAttemptId,
          runnerID: verification.runnerId,
        })
        .from(verification)
        .where(eq(verification.changeId, change.id));
      for (const recorded of verifications) {
        if (recorded.runtimeAttemptID) await runtime.stop(recorded.runtimeAttemptID);
        if (recorded.runnerID) await forge.deleteRunner(repository, Number(recorded.runnerID));
      }
      await retireBranch(change.id);
      await database.db
        .update(operationTable)
        .set({ error: null, updatedAt: query`now()` })
        .where(
          and(eq(operationTable.id, promotion.id), eq(operationTable.kind, "delivery.promotion")),
        );
    } catch (cause) {
      await database.db
        .update(operationTable)
        .set({
          error: bounded(cause instanceof Error ? cause.message : "Delivery cleanup failed"),
          updatedAt: query`now()`,
        })
        .where(
          and(eq(operationTable.id, promotion.id), eq(operationTable.kind, "delivery.promotion")),
        );
    }
  }
  return reconcilePromotion;
}
