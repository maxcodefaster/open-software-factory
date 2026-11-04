export type DeliveryBlockReason = "promotion-failed" | "merge-unconfirmed" | "in-progress";
export type DeliveryBlock = { title: string; reason: DeliveryBlockReason };
type DeliveryQueueChange = {
  id: string;
  ticketId: string;
  mergeState?: string | null | undefined;
  promotionState?: string | null | undefined;
};

// Mirrors the Delivery claim: one Change per Project owns an unfinished merge or Staging
// Promotion, and later approved Deliveries wait behind it. A failed merge releases the slot.
export function deliveryBlocker(
  own: { id: string; mergeState?: string | null | undefined },
  changes: readonly DeliveryQueueChange[],
): { ticketId: string; reason: DeliveryBlockReason } | undefined {
  if (own.mergeState && own.mergeState !== "pending") return undefined;
  const reasons = new Map<DeliveryBlockReason, string>();
  for (const change of changes) {
    if (change.id === own.id || !change.mergeState || change.mergeState === "failed") continue;
    const finished = change.mergeState === "succeeded" && change.promotionState === "succeeded";
    if (finished) continue;
    const reason: DeliveryBlockReason =
      change.promotionState === "failed"
        ? "promotion-failed"
        : change.mergeState === "ambiguous"
          ? "merge-unconfirmed"
          : "in-progress";
    // A stopped queue explains more than one that is merely busy.
    if (!reasons.has(reason)) reasons.set(reason, change.ticketId);
  }
  for (const reason of ["promotion-failed", "merge-unconfirmed", "in-progress"] as const) {
    const ticketId = reasons.get(reason);
    if (ticketId) return { ticketId, reason };
  }
  return undefined;
}

function deliveryBlockMessage(block: DeliveryBlock) {
  const title = block.title.length > 80 ? `${block.title.slice(0, 79)}…` : block.title;
  switch (block.reason) {
    case "promotion-failed":
      return `Waiting for "${title}". Its Main Preview failed, so Delivery is paused for this Project until that Ticket retries Main Preview. The approved version is retained and merges afterwards.`;
    case "merge-unconfirmed":
      return `Waiting for "${title}". Its merge is unconfirmed, so Delivery is paused until Factory confirms the outcome. The approved version is retained and merges afterwards.`;
    default:
      return `Waiting for "${title}" to finish Delivery. Deliveries run one at a time; the approved version merges next. No action needed.`;
  }
}

export type TicketProgressInput = {
  ticketState: string;
  changeState?: string | undefined;
  turnState?: string | undefined;
  turnPurpose?: string | undefined;
  implementationState?: string | undefined;
  building?: boolean | undefined;
  preparing?: boolean | undefined;
  verificationState?: string | undefined;
  verificationFailureKind?: string | undefined;
  verificationSummary?: string | undefined;
  verificationPreparationFailure?: string | undefined;
  correctionState?: string | undefined;
  reviewState?: string | undefined;
  checksPaused?: boolean | undefined;
  checksRetryable?: boolean | undefined;
  threads?: number | undefined;
  approved?: boolean | undefined;
  cleanupError?: string | undefined;
  promotionState?: string | undefined;
  deliveryBlock?: DeliveryBlock | undefined;
  canDevelop?: boolean | undefined;
  planning?: boolean | undefined;
  technicalPlanningOutstanding?: boolean | undefined;
  awaitingAnswer?: boolean | undefined;
};

// A read projection of known state, never an inferred result or a work command.
export function ticketProgress(input: TicketProgressInput): string {
  if (input.changeState === "delivered")
    return input.cleanupError
      ? "Delivery is complete. Resource cleanup needs attention; the delivered version is retained."
      : "The verified version was delivered to Staging. No action needed.";
  if (input.ticketState === "cancelled" || input.changeState === "cancelled")
    return "Work was cancelled. Source and history are retained; nothing restarts automatically.";
  if (input.changeState === "cancelling")
    return "Factory is stopping the work. Source and history are retained.";
  if (input.turnState === "uncertain")
    return "The last agent outcome is unconfirmed. Check the retained work before starting another request; Factory has not replayed it.";
  if (input.checksPaused)
    return "The submitted version is retained. Resume checks to continue without repeating implementation.";
  if (
    input.turnPurpose !== "review" &&
    (input.turnState === "stopped" || input.implementationState === "stopped")
  )
    return "Implementation is stopped. Retained code is not lost; resume deliberately when ready.";
  if (input.implementationState === "waiting")
    return "Implementation needs an answer. Open the Coding conversation to continue.";
  if (input.turnPurpose === "review" && input.changeState === "failed")
    return "Review preparation failed. The submitted version is retained. Retry review to continue without repeating implementation.";
  if (
    input.changeState === "failed" ||
    (input.turnPurpose !== "review" &&
      (input.turnState === "failed" || input.implementationState === "failed"))
  )
    return "Implementation could not finish. The Coding conversation shows the saved failure and offers Retry; retained work is kept.";
  if (input.changeState === "delivering") {
    if (input.promotionState === "failed")
      return "The verified version is merged, but Main Preview failed. Correct its setup and retry Main Preview. The previous Preview is retained.";
    if (input.deliveryBlock) return deliveryBlockMessage(input.deliveryBlock);
    return "Delivery is in progress. Factory keeps the existing Staging Preview until the replacement is ready.";
  }
  if (["pending", "dispatching", "running"].includes(input.correctionState ?? "")) {
    const failure =
      input.verificationState === "failed" &&
      input.verificationFailureKind === "check-failed" &&
      input.verificationSummary
        ? input.verificationSummary.slice(0, 220)
        : "A check or review found a problem.";
    return `${failure} Automatic correction is in progress; fresh checks follow. No action needed.`;
  }
  if (input.building && input.turnPurpose !== "review")
    return input.preparing
      ? "Factory is preparing the implementation. Approved requirements and existing code are retained. No action needed."
      : "The approved requirements are being implemented. Checks and independent review follow submission. No action needed.";
  if (!input.changeState) {
    if (input.awaitingAnswer)
      return "The Interview is waiting for your answer. Answer its question in the Assistant to continue; requirements are not ready to implement yet.";
    if (input.planning) return "Planning is in progress. Review the proposal when it is ready.";
    if (input.technicalPlanningOutstanding)
      return "Technical planning is unfinished. Continue technical planning before implementation.";
    return input.ticketState === "ready"
      ? "Requirements are saved. Confirm the scope with Implement when ready."
      : input.ticketState === "done"
        ? "This Ticket is complete. Its history is retained."
        : "Define the intended change and acceptance criteria before commissioning implementation.";
  }
  if (
    ["failed", "stopped", "uncertain", "incomplete"].includes(input.reviewState ?? "") ||
    (input.turnPurpose === "review" && ["failed", "stopped"].includes(input.turnState ?? ""))
  )
    return "Checks passed, but independent review is incomplete. Inspect its findings before explicitly retrying review.";
  if (
    input.implementationState &&
    input.implementationState !== "committed" &&
    input.turnPurpose !== "review"
  )
    return "Retained changes are not submitted. Finish implementation before treating earlier checks as current.";
  if (input.verificationState === "failed") {
    switch (input.verificationFailureKind) {
      case "execution-failed":
        return input.checksRetryable
          ? "The check environment failed before execution. Fix its setup, then Retry checks. The submitted version is retained."
          : "Verification could not execute its checks. Inspect the runner or job setup; application correctness remains unverified.";
      case "cancelled":
      case "skipped":
        return "Verification did not complete its checks. Inspect the Forgejo run; no application defect was established and no code correction was started.";
      case "unavailable":
        return "Verification failed, but the failed-step diagnosis is unavailable. Inspect the Forgejo run; no automatic code correction was started.";
      default:
        return "A verification check failed. Inspect the failed job; Delivery is blocked until fresh checks and review pass.";
    }
  }
  if (input.verificationState === "succeeded") {
    if (input.reviewState === "passed") {
      if (input.threads)
        return "Checks and independent review passed. Recheck and resolve the open Threads before Delivery.";
      if (input.approved && input.deliveryBlock) return deliveryBlockMessage(input.deliveryBlock);
      return input.approved
        ? "Delivery is approved for the exact verified version. Factory is preparing its merge and Staging Preview."
        : input.canDevelop
          ? "Checks and independent review passed. Review the result and approve Delivery when ready."
          : "Checks and independent review passed. A developer can review the result and approve Delivery.";
    }
    if (input.reviewState === "changes-requested")
      return "Independent review found problems. Delivery stays blocked while the findings are checked and corrected.";
    return "Implementation passed its checks. Independent review is next or in progress. No action needed.";
  }
  if (["pending", "runner-starting"].includes(input.verificationState ?? ""))
    return input.verificationPreparationFailure
      ? "Check preparation needs attention. Open checks for the recorded setup issue. The submitted version is retained."
      : "Implementation is submitted. Factory is preparing fresh checks for that exact version.";
  if (input.verificationState === "running")
    return "Implementation is submitted. Factory is running fresh checks on that exact version. No action needed.";
  if (input.verificationState === "cancelled")
    return "Checks were stopped. The submitted version remains unverified; inspect the run before continuing.";
  return "The submitted implementation is retained. Verification must finish before independent review and Delivery.";
}
