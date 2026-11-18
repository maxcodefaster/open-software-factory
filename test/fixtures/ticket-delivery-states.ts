import type { CandidateReviewResult } from "../../packages/conversation-domain/src/candidate-review";

export type DeliveryFixtureState = {
  change: {
    state: string;
    implementationState?: string;
    buildTurnState?: string;
    runtimeState?: string;
    failure?: string;
  };
  delivery: Record<string, unknown>;
  contributor?: boolean;
  /** Primary action expected beside the title, or null when none is offered. */
  primary: string | null;
  summary: string;
  /** Sentence the opened Checks details must contain. */
  detail?: string;
  /** Another Ticket's unfinished merge or Promotion that holds this Delivery in the queue. */
  deliveryBlock?: {
    title: string;
    reason: "promotion-failed" | "merge-unconfirmed" | "in-progress";
  };
  /** Sentence the Ticket progress line must contain. */
  progress?: string;
  /** Capacity wait must stay informational and must not imply a check result. */
  capacityWait?: boolean;
};

const passed = { verificationState: "succeeded", reviewState: "passed", reviewCurrent: true };
const active = { state: "active", implementationState: "committed", buildTurnState: "completed" };
const finding = (
  severity: "blocking" | "suggestion",
  title: string,
): CandidateReviewResult["findings"][number] =>
  ({
    severity,
    title,
    explanation: `${title}: the exported CSV drops the issue date for invoices created before the billing period starts, so a person cannot match rows to their records. Überschriften mit Umlauten bleiben lesbar.`,
    path: "apps/billing/src/export/invoices.ts",
    line: 42,
    reproduction:
      "Create an invoice dated 2026-09-30, choose the October period, export and compare the date column.",
  }) as CandidateReviewResult["findings"][number];

/** Every state the Ticket header and Checks details can show for a candidate through Delivery. */
export const deliveryStates: Record<string, DeliveryFixtureState> = {
  deliverable: {
    change: active,
    delivery: {
      ...passed,
      verificationComputeWait: true,
      verificationSummary: "Forgejo Actions passed ae257b465220.",
    },
    primary: "Deliver",
    summary: "Checks and independent review passed",
    detail: "Delivery still needs your approval.",
  },
  "open-threads": {
    change: active,
    delivery: { ...passed, openReviewThreads: 2 },
    primary: null,
    summary: "Checks and independent review passed",
  },
  contributor: {
    change: active,
    delivery: { ...passed },
    contributor: true,
    primary: null,
    summary: "Checks and independent review passed",
  },
  approved: {
    change: active,
    delivery: { ...passed, approvedAt: "2026-11-04T10:00:00Z" },
    primary: null,
    summary: "Checks and independent review passed",
    detail: "Delivery is approved.",
  },
  "policy-authorized": {
    change: { state: "delivering", implementationState: "committed" },
    delivery: {
      ...passed,
      deliveryPolicyId: "10000000-0000-4000-8000-0000000000aa",
      approvedAt: "2026-11-04T10:00:00Z",
      mergeState: "pending",
    },
    primary: null,
    summary: "Checks and independent review passed",
  },
  "checks-running": {
    change: active,
    delivery: { verificationState: "running", verificationComputeWait: true },
    primary: null,
    summary: "Checks running",
  },
  "check-capacity-pending": {
    change: active,
    delivery: { verificationState: "pending", verificationComputeWait: true },
    primary: null,
    summary: "Waiting for check capacity",
    detail: "Factory will start checks automatically when capacity is available.",
    progress: "Checks will start automatically when capacity is available. No action needed.",
    capacityWait: true,
  },
  "check-capacity-starting": {
    change: active,
    delivery: { verificationState: "runner-starting", verificationComputeWait: true },
    primary: null,
    summary: "Waiting for check capacity",
    detail: "The submitted version is retained.",
    progress: "Checks will start automatically when capacity is available. No action needed.",
    capacityWait: true,
  },
  "check-capacity-contributor": {
    change: active,
    delivery: { verificationState: "runner-starting", verificationComputeWait: true },
    contributor: true,
    primary: null,
    summary: "Waiting for check capacity",
    detail: "Delivery stays blocked until checks and independent review pass.",
    progress: "Checks will start automatically when capacity is available. No action needed.",
    capacityWait: true,
  },
  "checks-preparing-without-capacity-wait": {
    change: active,
    delivery: { verificationState: "pending" },
    primary: null,
    summary: "Preparing checks",
  },
  "check-capacity-inactive": {
    change: { ...active, state: "cancelled" },
    delivery: { verificationState: "pending", verificationComputeWait: true },
    primary: null,
    summary: "Preparing checks",
    progress: "Work was cancelled.",
  },
  "check-capacity-unsubmitted": {
    change: { ...active, implementationState: "waiting" },
    delivery: { verificationState: "pending", verificationComputeWait: true },
    primary: null,
    summary: "Corrections not submitted",
    detail: "Earlier checks do not verify the retained corrections.",
    progress: "Implementation needs an answer.",
  },
  "checks-preparing": {
    change: active,
    delivery: {
      verificationState: "pending",
      verificationComputeWait: true,
      verificationPreparationFailure: "The check environment image is still being prepared.",
    },
    primary: null,
    summary: "Check preparation needs attention",
  },
  "checks-failed": {
    change: active,
    delivery: {
      verificationState: "failed",
      verificationComputeWait: true,
      verificationSummary:
        "Forgejo Actions failed ae257b465220: 3 of 41 tests failed in apps/billing. See the Forgejo run for the retained log.",
      actionRunUrl: "https://forge.example/runs/7",
    },
    primary: null,
    summary: "Checks need attention",
    detail: "Delivery stays blocked until both pass.",
  },
  "check-environment-failed": {
    change: active,
    delivery: {
      verificationState: "failed",
      verificationComputeWait: true,
      verificationFailureKind: "execution-failed",
      verificationSummary: "The check environment stopped before the workflow finished.",
    },
    primary: null,
    summary: "Check environment failed",
  },
  "checks-paused": {
    change: active,
    delivery: {
      verificationState: "runner-starting",
      verificationComputeWait: true,
      checksStopId: "10000000-0000-4000-8000-0000000000bb",
    },
    primary: "Resume checks",
    summary: "Checks paused",
  },
  "checks-stopped": {
    change: active,
    delivery: { verificationState: "cancelled", verificationComputeWait: true },
    primary: null,
    summary: "Checks stopped",
  },
  "checks-retryable": {
    change: active,
    delivery: {
      verificationState: "failed",
      verificationComputeWait: true,
      verificationFailureKind: "execution-failed",
      checksRetryAttemptId: "10000000-0000-4000-8000-0000000000dd",
    },
    primary: "Retry checks",
    summary: "Check environment failed",
  },
  "review-pending": {
    change: active,
    delivery: { verificationState: "succeeded", reviewState: "running", reviewCurrent: true },
    primary: null,
    summary: "Independent review in progress",
  },
  "review-incomplete": {
    change: active,
    delivery: {
      verificationState: "succeeded",
      reviewState: "incomplete",
      reviewCurrent: true,
      reviewSummary:
        "Incomplete: no approved authenticated session was available to observe the form list.",
    },
    primary: "Retry review",
    summary: "Independent review needs attention",
  },
  "review-defects": {
    change: active,
    delivery: {
      verificationState: "succeeded",
      reviewState: "changes-requested",
      reviewCurrent: true,
      reviewSummary: "The candidate has two reproducible problems within the approved scope.",
      reviewFindings: [
        finding("blocking", "Export drops the issue date"),
        finding("suggestion", "Name the column after the billing period"),
      ],
    },
    primary: null,
    summary: "Review found defects",
  },
  correcting: {
    change: active,
    delivery: {
      verificationState: "succeeded",
      reviewState: "changes-requested",
      correctionState: "running",
    },
    primary: null,
    summary: "Automatic correction in progress",
  },
  "merge-pending": {
    change: { state: "delivering", implementationState: "committed" },
    delivery: { ...passed, approvedAt: "2026-11-04T10:00:00Z", mergeState: "pending" },
    primary: null,
    summary: "Checks and independent review passed",
  },
  "promotion-running": {
    change: { state: "delivering", implementationState: "committed" },
    delivery: {
      ...passed,
      approvedAt: "2026-11-04T10:00:00Z",
      mergeState: "succeeded",
      promotionState: "running",
    },
    primary: null,
    summary: "Checks and independent review passed",
  },
  "promotion-failed": {
    change: { state: "delivering", implementationState: "committed" },
    delivery: {
      ...passed,
      approvedAt: "2026-11-04T10:00:00Z",
      mergeState: "succeeded",
      promotionState: "failed",
      promotionId: "10000000-0000-4000-8000-0000000000cc",
      promotionFailure: "Main Preview did not answer on port 3001 within ten minutes.",
      cleanupError: "The replacement sandbox could not be removed yet.",
    },
    primary: "Retry Main Preview",
    summary: "Checks and independent review passed",
  },
  "queued-behind-failed-promotion": {
    change: { state: "delivering", implementationState: "committed" },
    delivery: { ...passed, approvedAt: "2026-11-04T10:00:00Z", mergeState: "pending" },
    deliveryBlock: { title: "Add invoice filters", reason: "promotion-failed" },
    primary: null,
    summary: "Checks and independent review passed",
    progress: 'Waiting for "Add invoice filters". Its Main Preview failed, so Delivery is paused',
  },
  "queued-behind-busy-delivery": {
    change: { state: "delivering", implementationState: "committed" },
    delivery: { ...passed, approvedAt: "2026-11-04T10:00:00Z", mergeState: "pending" },
    deliveryBlock: { title: "Überschriften mit Umlauten", reason: "in-progress" },
    primary: null,
    summary: "Checks and independent review passed",
    progress: 'Waiting for "Überschriften mit Umlauten" to finish Delivery',
  },
  delivered: {
    change: { state: "delivered", implementationState: "committed" },
    delivery: {
      ...passed,
      approvedAt: "2026-11-04T10:00:00Z",
      mergeState: "succeeded",
      promotionState: "succeeded",
    },
    primary: "Create follow-up",
    summary: "Checks and independent review passed",
  },
  "delivery-cleanup-pending": {
    change: { state: "delivered", implementationState: "committed" },
    delivery: {
      ...passed,
      approvedAt: "2026-11-04T10:00:00Z",
      mergeState: "succeeded",
      promotionState: "succeeded",
      cleanupError: "Delivery cleanup pending",
    },
    primary: "Create follow-up",
    summary: "Checks and independent review passed",
    progress: "Factory is cleaning up temporary resources. No action needed.",
    detail: "Factory is cleaning up temporary resources. No action needed.",
  },
  "delivery-cleanup-failed": {
    change: { state: "delivered", implementationState: "committed" },
    delivery: {
      ...passed,
      approvedAt: "2026-11-04T10:00:00Z",
      mergeState: "succeeded",
      promotionState: "succeeded",
      cleanupError: "Original Actor Delete remains unconfirmed",
    },
    primary: "Create follow-up",
    summary: "Checks and independent review passed",
    progress: "Resource cleanup needs attention; the delivered version is retained.",
    detail: "Resource cleanup needs attention; the delivered version is retained.",
  },
};
