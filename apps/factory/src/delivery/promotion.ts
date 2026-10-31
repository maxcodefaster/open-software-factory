import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient, ForgeRepository } from "../../../../packages/forge/src/forge";
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
    stop(id: string): Promise<RuntimeAttemptView | null>;
  },
  forge: Pick<ReturnType<typeof createForgejoClient>, "deleteRunner">,
  retireBranch: (id: string) => Promise<void>,
) {
  const bounded = (value: string) => (value.length <= 2000 ? value : `${value.slice(0, 1999)}…`);
  async function reconcilePromotion(change: PromotionChange, repository: ForgeRepository) {
    const rows = await database.client<
      Array<{
        id: string;
        commitSHA: string;
        state: string;
        previousAttemptID: string | null;
        replacementAttemptID: string | null;
        replacementState: string | null;
        lastError: string | null;
        retryActorID: string | null;
      }>
    >`
      SELECT promotion.id, promotion.commit_sha AS "commitSHA", promotion.state, promotion.last_error AS "lastError",
        promotion.previous_runtime_attempt_id AS "previousAttemptID",
        promotion.replacement_runtime_attempt_id AS "replacementAttemptID",
        attempt.state AS "replacementState", command.actor_id AS "retryActorID"
      FROM factory.current_promotion promotion
      LEFT JOIN factory.execution_policy_command command ON command.command_id=promotion.retry_command_id
      LEFT JOIN factory.runtime_attempt attempt
        ON attempt.id = promotion.replacement_runtime_attempt_id
      WHERE promotion.change_id = ${change.id}
    `;
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
      await database.client`
        UPDATE factory.promotion_operation SET state = 'failed',
          last_error = 'Replacement Staging failed before readiness', completed_at = now(),
          updated_at = now() WHERE id = ${promotion.id}
      `;
      return;
    }
    if (promotion.replacementState !== "ready") return;
    await database.client.begin(async (transaction) => {
      await transaction`
        UPDATE factory.promotion_operation SET state = 'switching', updated_at = now()
        WHERE id = ${promotion.id} AND state = 'starting'
      `;
      await transaction`
        UPDATE factory.staging_preview
        SET revision = ${promotion.commitSHA},
          runtime_attempt_id = ${promotion.replacementAttemptID}, updated_at = now()
        WHERE project_id = ${change.projectID}
      `;
      await transaction`
        UPDATE factory.promotion_operation SET state = 'succeeded', completed_at = now(),
          updated_at = now(), last_error = 'Delivery cleanup pending' WHERE id = ${promotion.id}
      `;
      await transaction`
        UPDATE factory.change SET state = 'delivered', cancel_requested_at = now(),
          failure = NULL, version = version + 1 WHERE id = ${change.id}
      `;
      await transaction`
        UPDATE factory.ticket SET state = 'done', version = version + 1, updated_at = now()
        WHERE id = ${change.ticketID}
      `;
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
      if (change.runtimeAttemptID) await runtime.stop(change.runtimeAttemptID);
      const verifications = await database.client<
        Array<{ runtimeAttemptID: string | null; runnerID: string | null }>
      >`
      SELECT runtime_attempt_id AS "runtimeAttemptID", runner_id AS "runnerID"
      FROM factory.verification WHERE change_id = ${change.id}
    `;
      for (const verification of verifications) {
        if (verification.runtimeAttemptID) await runtime.stop(verification.runtimeAttemptID);
        if (verification.runnerID)
          await forge.deleteRunner(repository, Number(verification.runnerID));
      }
      await retireBranch(change.id);
      await database.client`UPDATE factory.promotion_operation SET last_error = NULL, updated_at = now() WHERE id = ${promotion.id}`;
    } catch (cause) {
      await database.client`UPDATE factory.promotion_operation SET last_error = ${bounded(cause instanceof Error ? cause.message : "Delivery cleanup failed")}, updated_at = now() WHERE id = ${promotion.id}`;
    }
  }
  return reconcilePromotion;
}
