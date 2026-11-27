import { createMemo } from "solid-js";
import { ticketBoardStatus } from "#interface-domain/ticket-board";
import type { RequirementProposal, TechnicalDesignRevision } from "../change/contracts";
import type { ReviewActions } from "../review/panel";
import type { TicketHeaderAction } from "./ticket-action-bar";
import {
  effectiveOpenReviewThreads,
  isActiveTurnState,
  technicalDesignStale,
} from "./ticket-state-helpers";
import {
  canEditTicketSpecification,
  type TicketDocumentRevisionView,
  type TicketView,
  type TicketWorkspaceProps,
} from "./ticket-workspace-types";

export const INCOMPLETE_REQUIREMENTS_REASON =
  "Add a summary and at least one acceptance criterion to enable Implement.";

export type TicketPrimaryActionContext = {
  ticketState: TicketView["state"];
  continueTechnical: boolean;
  technicalPlanningPending: boolean;
};

/**
 * Selects at most one primary header action by explicit stage priority so
 * no ticket state ever presents competing primary buttons.
 */
export function selectPrimaryHeaderActionId(
  actions: readonly Pick<TicketHeaderAction, "id">[],
  context: TicketPrimaryActionContext,
): string | undefined {
  const has = (id: string) => actions.some((action) => action.id === id);

  if (has("restore")) return "restore";
  if (has("confirm")) return "confirm";
  if (has("retry-promotion")) return "retry-promotion";
  if (has("resume-coding")) return "resume-coding";
  if (has("resume-checks")) return "resume-checks";
  if (has("retry-review")) return "retry-review";
  if (has("revision")) return "revision";
  if (has("deliver")) return "deliver";
  if (has("follow-up")) return "follow-up";
  if (context.continueTechnical && has("interview")) return "interview";
  if (!context.technicalPlanningPending && has("implement")) return "implement";
  if ((context.ticketState === "inbox" || context.ticketState === "backlog") && has("interview"))
    return "interview";
  if (has("epic")) return "epic";
  return undefined;
}

export function createTicketWorkspaceActions(options: {
  props: TicketWorkspaceProps;
  proposal: () => RequirementProposal | undefined;
  currentDocument: () => TicketDocumentRevisionView | undefined;
  hasChanges: () => boolean;
  saving: () => boolean;
  technical: () => TechnicalDesignRevision | undefined;
  technicalDirty: () => boolean;
  openReviewThreads: () => number | undefined;
  reviewActions: () => ReviewActions | undefined;
  onConfirmProposal: () => Promise<void>;
}) {
  const canEditSpecification = () => canEditTicketSpecification(options.props.current.ticket);
  const effectiveStatus = () =>
    ticketBoardStatus({
      ticketState: options.props.current.ticket.state,
      changeState: options.props.change?.state,
      verificationState: options.props.change?.verificationState,
      buildTurnState: options.props.buildInProgress
        ? "running"
        : options.props.change?.buildTurnState,
      buildTurnPurpose: options.props.change?.buildTurnPurpose,
      implementationState: options.props.change?.implementationState,
    });
  const implementationBusy = () =>
    options.props.buildInProgress ||
    isActiveTurnState(options.props.change?.buildTurnState) ||
    ["starting", "working"].includes(options.props.change?.implementationState ?? "");
  const implementationPreparing = () =>
    options.props.change?.buildTurnPurpose !== "review" &&
    options.props.change?.buildTurnState !== "running" &&
    options.props.change?.implementationState !== "working" &&
    (["branch-pending", "starting"].includes(options.props.change?.state ?? "") ||
      options.props.change?.buildTurnState === "pending" ||
      options.props.change?.implementationState === "starting");
  const canDeliver = () =>
    !options.props.current.ticket.trashedAt &&
    options.props.canDevelop &&
    options.props.change?.state === "active" &&
    options.props.change.implementationState === "committed" &&
    !implementationBusy() &&
    options.props.delivery?.verificationState === "succeeded" &&
    options.props.delivery?.reviewState === "passed" &&
    !(
      effectiveOpenReviewThreads(
        options.openReviewThreads(),
        options.props.delivery?.openReviewThreads,
      ) ?? 0
    ) &&
    !options.props.delivery.approvedAt;

  const canImplement = () =>
    Boolean(
      !options.props.current.ticket.trashedAt &&
        !options.props.current.ticket.convertedToEpicId &&
        options.props.current.ticket.state === "ready" &&
        options.props.latestRevision &&
        !options.props.change &&
        options.props.current.implementationOrder?.state !== "waiting" &&
        !options.proposal(),
    );
  const implementationDisabledReason = () => {
    if (options.props.pending) return "Finishing the current Ticket action.";
    if (options.props.planningBusy) return "Wait for Planning to finish.";
    if (options.props.current.technicalPlanningPending)
      return "Finish Technical Planning before implementation.";
    if (options.technicalDirty()) return "Save or discard your technical design edits.";
    if (options.props.current.technicalDesignPresent && !options.props.canDevelop)
      return "A developer must review and approve the technical design.";
    if (technicalDesignStale(options.technical(), options.props.latestRevision?.id))
      return "Update the technical design for the current product specification.";
    if (options.hasChanges()) return "Waiting for your requirements to save.";
    if (
      options.currentDocument() &&
      options.currentDocument()?.requirementRevisionId !== options.props.latestRevision?.id
    )
      return "Complete the current requirements before starting implementation.";
    if (!options.props.implementationAvailable) return "Connect a Coding model in Settings first.";
    return undefined;
  };
  const implementationDisabled = () => Boolean(implementationDisabledReason());
  // A Ticket is ready before its requirements are complete; saving creates the revision Implement needs.
  const requirementsIncomplete = () =>
    !options.props.current.ticket.trashedAt &&
    !options.props.current.ticket.convertedToEpicId &&
    options.props.current.ticket.state === "ready" &&
    !options.props.latestRevision &&
    !options.props.change &&
    !options.proposal();
  // Transient reasons already show elsewhere (pending command, unsaved edits); the rest need visible text.
  const visibleDisabledReason = () => {
    if (!canImplement() || options.props.codingOptionsOpen) return undefined;
    const reason = implementationDisabledReason();
    return reason === "Finishing the current Ticket action." ||
      reason === "Waiting for your requirements to save."
      ? undefined
      : reason;
  };
  const canInterview = () =>
    !options.props.current.ticket.trashedAt &&
    !options.props.current.ticket.convertedToEpicId &&
    options.props.current.ticket.state !== "cancelled" &&
    !options.props.latestRevision?.approvalId &&
    !options.props.change &&
    !options.proposal();

  const headerActions = createMemo(() => {
    const actions: TicketHeaderAction[] = [];
    const ticket = options.props.current.ticket;
    const review = options.reviewActions();
    const continueTechnical =
      options.props.canDevelop && options.props.current.technicalPlanningPending
        ? options.props.onTechnicalPlanning
        : undefined;
    if (canInterview() && !options.props.clarificationAction.status)
      actions.push({
        id: "interview",
        label: continueTechnical
          ? "Continue technical planning"
          : options.props.clarificationAction.label,
        title: continueTechnical
          ? "Continues the technical design for the confirmed product specification without restarting the product Interview."
          : options.props.canDevelop && options.props.onFullPlanning
            ? "Clarifies the product requirements, then prepares the technical design after you confirm them."
            : undefined,
        disabled:
          options.hasChanges() ||
          options.technicalDirty() ||
          options.props.planningBusy ||
          options.props.pending,
        run:
          continueTechnical ??
          (options.props.canDevelop && options.props.onFullPlanning
            ? options.props.onFullPlanning
            : options.props.onInterview),
      });
    if (ticket.convertedToEpicId)
      actions.push({
        id: "epic",
        label: "Open Epic",
        run: () => ticket.convertedToEpicId && options.props.onOpenEpic(ticket.convertedToEpicId),
      });
    if (!ticket.trashedAt && options.props.change && options.props.onOpenPreview)
      actions.push({
        id: "preview",
        label: "Open Live Preview",
        persistent: true,
        run: options.props.onOpenPreview,
      });
    if (
      !ticket.trashedAt &&
      options.props.change &&
      options.props.canDevelop &&
      options.props.onOpenIDE &&
      !["cancelled", "cancelling", "delivering", "delivered"].includes(options.props.change.state)
    )
      actions.push({
        id: "ide",
        label: "Open IDE",
        persistent: true,
        run: options.props.onOpenIDE,
      });
    if (!ticket.trashedAt && implementationBusy())
      actions.push({
        id: "stop",
        label: "Stop implementation",
        danger: true,
        disabled: options.props.pending,
        run: options.props.onStopImplementation,
      });
    if (!ticket.trashedAt && review?.addFeedback)
      actions.push({ id: "feedback", label: "Add feedback", run: review.addFeedback });
    if (ticket.trashedAt)
      actions.push({
        id: "restore",
        label: "Restore",
        disabled: options.props.pending || Boolean(ticket.trashStopPending),
        run: options.props.onRestore,
      });
    if (options.proposal())
      actions.push({
        id: "confirm",
        label: options.proposal()?.fullPlanning ? "Confirm product spec" : "Confirm answers",
        disabled:
          options.props.pending ||
          options.saving() ||
          options.proposal()?.base.version !== ticket.version,
        run: () => void options.onConfirmProposal(),
      });
    if (canDeliver())
      actions.push({
        id: "deliver",
        label: "Deliver",
        disabled: options.props.pending,
        run: () => options.props.change && options.props.onApproveDelivery(options.props.change.id),
      });
    if (
      !ticket.trashedAt &&
      options.props.canDevelop &&
      options.props.change?.state === "delivering" &&
      options.props.delivery?.mergeState === "succeeded" &&
      options.props.delivery.promotionState === "failed" &&
      options.props.delivery.promotionId &&
      options.props.onRetryPromotion
    )
      actions.push({
        id: "retry-promotion",
        label: "Retry Main Preview",
        disabled: options.props.pending,
        run: () =>
          options.props.change && options.props.onRetryPromotion?.(options.props.change.id),
      });
    if (requirementsIncomplete())
      actions.push({
        id: "implement",
        label: "Implement",
        disabled: true,
        title: INCOMPLETE_REQUIREMENTS_REASON,
        describedBy: "ticket-action-reason",
        run: () => {},
      });
    if (canImplement() && !options.props.codingOptionsOpen)
      actions.push({
        id: "implement",
        label: options.props.dependencies.prerequisites.some((item) => !item.delivered)
          ? "Queue implementation"
          : "Implement",
        disabled: implementationDisabled(),
        title: implementationDisabledReason(),
        describedBy: visibleDisabledReason() ? "ticket-action-reason" : undefined,
        run: () =>
          options.props.latestRevision &&
          options.props.onImplement(options.props.latestRevision.id),
      });
    if (
      options.props.current.implementationOrder?.state === "waiting" &&
      options.props.onCancelImplementation &&
      (options.props.current.implementationOrder.canCancel ?? options.props.canDevelop)
    )
      actions.push({
        id: "cancel-implementation",
        label: "Cancel queued implementation",
        disabled: options.props.pending,
        run: () => options.props.onCancelImplementation?.(),
      });
    if (!ticket.trashedAt && options.props.codingPause)
      actions.push({
        id: "resume-coding",
        label: "Resume implementation",
        disabled:
          options.props.pending ||
          ["dispatching", "running"].includes(options.props.change?.buildTurnState ?? ""),
        run: () => options.props.onResumeCoding?.(),
      });
    if (
      !ticket.trashedAt &&
      options.props.canDevelop &&
      (options.props.delivery?.checksStopId || options.props.delivery?.checksRetryAttemptId) &&
      options.props.onResumeChecks
    )
      actions.push({
        id: "resume-checks",
        label: options.props.delivery?.checksStopId ? "Resume checks" : "Retry checks",
        disabled: options.props.pending,
        run: () => options.props.change && options.props.onResumeChecks?.(options.props.change.id),
      });
    if (
      !ticket.trashedAt &&
      (options.props.change?.state === "active" ||
        (["starting", "failed"].includes(options.props.change?.state ?? "") &&
          ["stopped", "failed"].includes(options.props.change?.runtimeState ?? ""))) &&
      !implementationBusy() &&
      !options.props.codingPause &&
      ["incomplete", "failed", "stopped"].includes(options.props.delivery?.reviewState ?? "") &&
      options.props.onRetryReview
    )
      actions.push({
        id: "retry-review",
        label: "Retry review",
        disabled: options.props.pending,
        run: () => options.props.change && options.props.onRetryReview?.(options.props.change.id),
      });
    if (!ticket.trashedAt && review?.revision)
      actions.push({
        id: "revision",
        label: `${review.revision.sending ? "Requesting revision…" : "Request revision"} · ${review.revision.count} ${review.revision.count === 1 ? "Thread" : "Threads"}`,
        disabled: options.props.pending || review.revision.disabled,
        title: `Revise ${review.revision.count} eligible open ${review.revision.count === 1 ? "Thread" : "Threads"}. Comments and Threads awaiting recheck are excluded.`,
        run: review.revision.request,
      });
    if (!ticket.trashedAt && options.props.change?.state === "delivered")
      actions.push({
        id: "follow-up",
        label: "Create follow-up",
        disabled: options.props.pending || options.hasChanges(),
        run: options.props.onFollowUp,
      });
    const primaryId = selectPrimaryHeaderActionId(actions, {
      ticketState: ticket.state,
      continueTechnical: Boolean(continueTechnical),
      technicalPlanningPending: Boolean(options.props.current.technicalPlanningPending),
    });
    return primaryId
      ? actions.map((action) => (action.id === primaryId ? { ...action, primary: true } : action))
      : actions;
  });

  const compactActions = createMemo(() => {
    const actions = headerActions();
    const primary = actions.find((action) => action.primary)?.id;
    return primary
      ? actions.filter(
          (action) => action.id !== primary && !action.persistent && action.id !== "stop",
        )
      : [];
  });

  return {
    canEditSpecification,
    effectiveStatus,
    implementationBusy,
    implementationPreparing,
    canDeliver,
    canImplement,
    implementationDisabled,
    requirementsIncomplete,
    incompleteReason: INCOMPLETE_REQUIREMENTS_REASON,
    visibleDisabledReason,
    canInterview,
    headerActions,
    compactActions,
  };
}

export type TicketWorkspaceActionsController = ReturnType<typeof createTicketWorkspaceActions>;
