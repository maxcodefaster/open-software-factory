import { ticketProgress } from "#interface-domain/ticket-progress";
import type { TechnicalDesignRevision } from "../change/contracts";
import { technicalDesignStale } from "./ticket-state-helpers";
import type { TicketWorkspaceProps } from "./ticket-workspace-types";

export type TicketTechnicalBadgeState =
  | { kind: "hidden" }
  | { kind: "editing"; label: "Editing technical design" }
  | { kind: "planning-required"; label: "Technical planning required" }
  | { kind: "stale"; label: "Technical design out of date" }
  | { kind: "review-required"; label: "Developer review required" };

export type TicketSaveFeedbackState =
  | { kind: "proposal-private" }
  | { kind: "standard"; state: "saving" | "error" | "dirty" | "saved" | "idle" };

export type TicketActivityNoticeState =
  | { kind: "none" }
  | { kind: "compute-wait" }
  | { kind: "coding-paused"; reason: "accounting-incomplete" | "allowance" };

export type TicketProgressBannerState =
  | { kind: "hidden" }
  | {
      kind:
        | "waiting"
        | "blocked"
        | "technical-dirty"
        | "proposal-review"
        | "incomplete"
        | "progress";
      message: string;
      hasActionReasonId: boolean;
    };

export type TicketSaveErrorState =
  | { kind: "hidden" }
  | { kind: "conflict"; message: string; saving: boolean }
  | { kind: "retryable"; message: string; saving: boolean }
  | { kind: "error"; message: string };

export function resolveTicketTechnicalBadge(options: {
  workspace: TicketWorkspaceProps;
  hasProposal: boolean;
  technical: TechnicalDesignRevision | undefined;
  technicalDirty: boolean;
}): TicketTechnicalBadgeState {
  const { workspace, hasProposal, technical, technicalDirty } = options;
  if (
    workspace.change ||
    hasProposal ||
    workspace.current.ticket.state !== "ready" ||
    !workspace.latestRevision
  )
    return { kind: "hidden" };
  if (technicalDirty) return { kind: "editing", label: "Editing technical design" };
  if (workspace.current.technicalPlanningPending)
    return { kind: "planning-required", label: "Technical planning required" };
  if (technicalDesignStale(technical, workspace.latestRevision.id))
    return { kind: "stale", label: "Technical design out of date" };
  if (workspace.current.technicalDesignPresent && !workspace.canDevelop)
    return { kind: "review-required", label: "Developer review required" };
  return { kind: "hidden" };
}

export function resolveTicketSaveFeedback(options: {
  hasProposal: boolean;
  editing: boolean;
  hasChanges: boolean;
  saving: boolean;
  editorError: string | undefined;
  savedDocument: boolean;
}): TicketSaveFeedbackState {
  if (
    options.hasProposal &&
    options.editing &&
    options.hasChanges &&
    !options.saving &&
    !options.editorError
  )
    return { kind: "proposal-private" };
  if (options.saving) return { kind: "standard", state: "saving" };
  if (options.editorError) return { kind: "standard", state: "error" };
  if (options.editing && options.hasChanges) return { kind: "standard", state: "dirty" };
  if (options.savedDocument) return { kind: "standard", state: "saved" };
  return { kind: "standard", state: "idle" };
}

export function resolveTicketActivityNotice(
  workspace: Pick<TicketWorkspaceProps, "computeWait" | "codingPause">,
): TicketActivityNoticeState {
  if (workspace.codingPause) {
    return {
      kind: "coding-paused",
      reason:
        workspace.codingPause.reason === "accounting-incomplete"
          ? "accounting-incomplete"
          : "allowance",
    };
  }
  if (workspace.computeWait) return { kind: "compute-wait" };
  return { kind: "none" };
}

export function resolveTicketProgressBanner(options: {
  workspace: TicketWorkspaceProps;
  hasProposal: boolean;
  technicalDirty: boolean;
  requirementsIncomplete: boolean;
  incompleteReason: string;
  description: string;
  summary: string;
  implementationBusy: boolean;
  implementationPreparing: boolean;
  openThreads: number | undefined;
}): TicketProgressBannerState {
  const { workspace } = options;
  if (
    workspace.computeWait ||
    workspace.codingPause ||
    workspace.current.ticket.trashedAt ||
    workspace.current.ticket.convertedToEpicId
  )
    return { kind: "hidden" };
  const hasSignal = Boolean(
    workspace.change ||
      workspace.planningBusy ||
      workspace.awaitingAnswer ||
      options.hasProposal ||
      workspace.current.implementationOrder ||
      workspace.current.technicalPlanningPending ||
      options.technicalDirty ||
      options.requirementsIncomplete ||
      (!options.description.trim() && !options.summary.trim()),
  );
  if (!hasSignal) return { kind: "hidden" };
  const hasActionReasonId = options.requirementsIncomplete;
  if (workspace.current.implementationOrder?.state === "waiting") {
    const waitingFor =
      workspace.dependencies.prerequisites
        .filter((item) => !item.delivered)
        .map((item) => item.title)
        .join(", ") || "prerequisite Delivery";
    return {
      kind: "waiting",
      hasActionReasonId,
      message:
        workspace.current.implementationOrder.reason ??
        `Implementation queued. Waiting for ${waitingFor}. It will start automatically.`,
    };
  }
  if (workspace.current.implementationOrder?.state === "blocked") {
    return {
      kind: "blocked",
      hasActionReasonId,
      message:
        workspace.current.implementationOrder.reason ??
        "Queued implementation needs attention. Review the current scope and commission it again.",
    };
  }
  if (options.technicalDirty) {
    return {
      kind: "technical-dirty",
      hasActionReasonId: true,
      message:
        "Save design or Discard edits in the Technical design chapter before using Implement. Saving does not start work.",
    };
  }
  if (options.hasProposal && !workspace.planningBusy) {
    return {
      kind: "proposal-review",
      hasActionReasonId,
      message: "Review this proposal. Your edits stay private until you confirm.",
    };
  }
  if (options.requirementsIncomplete && !workspace.planningBusy && !workspace.awaitingAnswer) {
    return {
      kind: "incomplete",
      hasActionReasonId: true,
      message: options.incompleteReason,
    };
  }
  const explainsPlanningReason = Boolean(
    !workspace.change &&
      !workspace.awaitingAnswer &&
      (workspace.planningBusy || workspace.current.technicalPlanningPending),
  );
  return {
    kind: "progress",
    hasActionReasonId: hasActionReasonId || explainsPlanningReason,
    message: ticketProgress({
      ticketState: workspace.current.ticket.state,
      changeState: workspace.change?.state,
      turnState: workspace.change?.buildTurnState,
      turnPurpose: workspace.change?.buildTurnPurpose,
      implementationState: workspace.change?.implementationState,
      building: options.implementationBusy,
      preparing: options.implementationPreparing,
      verificationState: workspace.delivery?.verificationState,
      verificationFailureKind: workspace.delivery?.verificationFailureKind,
      verificationSummary: workspace.delivery?.verificationSummary,
      verificationPreparationFailure: workspace.delivery?.verificationPreparationFailure,
      verificationComputeWait: workspace.delivery?.verificationComputeWait,
      correctionState: workspace.delivery?.correctionState,
      reviewState: workspace.delivery?.reviewState,
      checksPaused: Boolean(workspace.delivery?.checksStopId),
      checksRetryable: Boolean(workspace.delivery?.checksRetryAttemptId),
      threads: options.openThreads,
      approved: Boolean(workspace.delivery?.approvedAt),
      cleanupError: workspace.delivery?.cleanupError,
      promotionState: workspace.delivery?.promotionState,
      deliveryBlock: workspace.deliveryBlock,
      canDevelop: workspace.canDevelop,
      planning: workspace.planningBusy,
      awaitingAnswer: workspace.awaitingAnswer,
      technicalPlanningOutstanding: workspace.current.technicalPlanningPending,
    }),
  };
}

export function resolveTicketSaveError(options: {
  editorError: string | undefined;
  conflict: boolean;
  saving: boolean;
  hasChanges: boolean;
  hasProposal: boolean;
  title: string;
}): TicketSaveErrorState {
  if (!options.editorError) return { kind: "hidden" };
  if (options.conflict) {
    return { kind: "conflict", message: options.editorError, saving: options.saving };
  }
  if (options.hasChanges && !options.hasProposal && options.title.trim()) {
    return { kind: "retryable", message: options.editorError, saving: options.saving };
  }
  return { kind: "error", message: options.editorError };
}

export function resolveTicketChecksFlags(options: {
  workspace: TicketWorkspaceProps;
  implementationBusy: boolean;
  implementationPreparing: boolean;
}) {
  const { workspace, implementationBusy, implementationPreparing } = options;
  return {
    building: implementationBusy && !workspace.computeWait && !workspace.codingPause,
    preparing: implementationPreparing,
    paused: Boolean(workspace.codingPause),
    inactive:
      workspace.change?.state !== "active" ||
      workspace.current.ticket.state === "cancelled" ||
      Boolean(workspace.current.ticket.trashedAt),
    unsubmitted:
      workspace.change?.state === "active" &&
      ((workspace.change.implementationState !== undefined &&
        workspace.change.implementationState !== "committed") ||
        ["failed", "stopped", "uncertain"].includes(workspace.change.buildTurnState ?? "")),
  };
}
