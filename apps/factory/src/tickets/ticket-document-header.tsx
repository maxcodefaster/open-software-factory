import { For, Match, Show, Switch } from "solid-js";
import type { TechnicalDesignRevision } from "../change/contracts";
import { type ReviewActions, ReviewThreadStatus } from "../review/panel";
import { sourceReviewURL } from "../source-review";
import { Feedback, SaveFeedback } from "../ui/feedback";
import { TicketActionBar } from "./ticket-action-bar";
import { TicketChecks } from "./ticket-checks";
import { resolveHeaderPlanningBadges } from "./ticket-header-planning-badges";
import { TicketSecondaryActions } from "./ticket-secondary-actions";
import {
  resolveTicketActivityNotice,
  resolveTicketChecksFlags,
  resolveTicketProgressBanner,
  resolveTicketSaveFeedback,
  resolveTicketTechnicalBadge,
} from "./ticket-section-state";
import { effectiveOpenReviewThreads } from "./ticket-state-helpers";
import type { TicketWorkspaceActionsController } from "./ticket-workspace-actions";
import type { TicketDraftController } from "./ticket-workspace-draft";
import { RichTextSurface } from "./ticket-workspace-slash";
import type {
  RequirementRevisionView,
  RichTextHandlerOptions,
  RichTextHandlers,
  TicketWorkspaceProps,
} from "./ticket-workspace-types";

export function TicketDocumentHeader(props: {
  workspace: TicketWorkspaceProps;
  draft: TicketDraftController;
  actions: TicketWorkspaceActionsController;
  reviewActions: ReviewActions | undefined;
  openReviewThreads: number | undefined;
  technical: TechnicalDesignRevision | undefined;
  technicalDirty: boolean;
  historyOpen: boolean;
  documentNotice: boolean;
  implementationRevision: RequirementRevisionView | undefined;
  richTextHandlers: (options: RichTextHandlerOptions) => RichTextHandlers;
  onToggleHistory: () => void;
  onOpenCurrentHistory: () => void;
  onDismissDocumentNotice: () => void;
}) {
  const openThreads = () =>
    effectiveOpenReviewThreads(
      props.openReviewThreads,
      props.workspace.delivery?.openReviewThreads,
    );
  const technicalBadge = () =>
    resolveTicketTechnicalBadge({
      workspace: props.workspace,
      hasProposal: Boolean(props.draft.proposal()),
      technical: props.technical,
      technicalDirty: props.technicalDirty,
    });
  const saveFeedback = () =>
    resolveTicketSaveFeedback({
      hasProposal: Boolean(props.draft.proposal()),
      editing: props.draft.editing(),
      hasChanges: props.draft.hasChanges(),
      saving: props.draft.saving(),
      editorError: props.draft.editorError(),
      savedDocument: props.draft.savedDocument(),
    });
  const activityNotice = () => resolveTicketActivityNotice(props.workspace);
  const progressBanner = () =>
    resolveTicketProgressBanner({
      workspace: props.workspace,
      hasProposal: Boolean(props.draft.proposal()),
      technicalDirty: props.technicalDirty,
      requirementsIncomplete: props.actions.requirementsIncomplete(),
      incompleteReason: props.actions.incompleteReason,
      description: props.draft.description(),
      summary: props.draft.summary(),
      implementationBusy: props.actions.implementationBusy(),
      implementationPreparing: props.actions.implementationPreparing(),
      openThreads: openThreads(),
    });
  const checksFlags = () =>
    resolveTicketChecksFlags({
      workspace: props.workspace,
      implementationBusy: props.actions.implementationBusy(),
      implementationPreparing: props.actions.implementationPreparing(),
    });
  const planningBadges = () =>
    resolveHeaderPlanningBadges({
      technicalBadge: technicalBadge(),
      hasChange: Boolean(props.workspace.change),
      hasProposal: Boolean(props.draft.proposal()),
      technicalPlanningPending: Boolean(props.workspace.current.technicalPlanningPending),
      planningBusy: Boolean(props.workspace.planningBusy),
      canInterview: props.actions.canInterview(),
      clarificationAction: props.workspace.clarificationAction,
    });
  const visibleTechnicalBadge = () => planningBadges().technicalBadge;
  const visibleClarificationStatus = () => planningBadges().clarificationStatus;
  const standardSaveFeedback = () => {
    const feedback = saveFeedback();
    return feedback.kind === "standard" ? feedback.state : undefined;
  };
  const visibleProgressBanner = () => {
    const banner = progressBanner();
    return banner.kind === "hidden" ? undefined : banner;
  };
  const codingPausedMessage = () => {
    const notice = activityNotice();
    if (notice.kind !== "coding-paused") return undefined;
    return notice.reason === "accounting-incomplete"
      ? "Coding paused because consumption or pricing is incomplete."
      : "Coding paused at its allowance.";
  };
  const progressBannerActionable = (kind: string) =>
    kind === "blocked" ||
    kind === "technical-dirty" ||
    kind === "proposal-review" ||
    kind === "incomplete" ||
    Boolean(
      kind === "progress" &&
        !props.workspace.change &&
        !props.workspace.planningBusy &&
        !props.workspace.awaitingAnswer &&
        props.workspace.current.technicalPlanningPending,
    );

  return (
    <header class="ticket-document-heading">
      <div class="ticket-status-row workspace-heading">
        <RichTextSurface
          value={props.draft.title()}
          label="Ticket title"
          field="title"
          editable={props.actions.canEditSpecification()}
          plain={true}
          placeholder="Untitled ticket"
          class="ticket-inline-title workspace-heading-title"
          {...props.richTextHandlers({ update: props.draft.setTitle })}
        />
        <TicketActionBar
          actions={props.actions.headerActions()}
          people={props.workspace.people}
          menu={
            <Show
              when={
                !props.workspace.current.ticket.convertedToEpicId ||
                props.workspace.current.revisions.length ||
                props.workspace.current.documentRevisions.length
              }
            >
              <TicketSecondaryActions
                compactActions={props.actions.compactActions()}
                onReloadReview={props.reviewActions?.reload}
                requestDetails={
                  props.draft.separateSummary() ? (
                    <RichTextSurface
                      attachmentScopeKey={`ticket:${props.workspace.current.ticket.id}:description`}
                      value={props.draft.description()}
                      label="Request details"
                      field="description"
                      editable={props.actions.canEditSpecification()}
                      placeholder="Add planning context"
                      class="ticket-inline-description markdown-body"
                      {...props.richTextHandlers({
                        slash: true,
                        update: props.draft.updateDescription,
                      })}
                    />
                  ) : undefined
                }
                reviewSourceURL={
                  props.workspace.canDevelop
                    ? sourceReviewURL(props.workspace.delivery?.pullRequestUrl)
                    : undefined
                }
                onCodingOptions={
                  props.workspace.canDevelop && props.actions.canImplement()
                    ? () =>
                        props.workspace.latestRevision &&
                        props.workspace.onCodingOptions(props.workspace.latestRevision.id)
                    : undefined
                }
                codingOptionsDisabled={props.actions.implementationDisabled()}
                converted={Boolean(props.workspace.current.ticket.convertedToEpicId)}
                epics={props.workspace.epics}
                epicID={props.workspace.current.ticket.epicId}
                pending={props.workspace.pending || Boolean(props.workspace.dependencies.pending)}
                pullRequestUrl={props.workspace.delivery?.pullRequestUrl}
                failure={props.workspace.change?.failure}
                cleanupError={props.workspace.delivery?.cleanupError}
                canStop={props.actions.implementationBusy()}
                onAssignEpic={props.workspace.onAssignEpic}
                onStop={props.workspace.onStopImplementation}
                dependencies={{
                  candidates: props.workspace.dependencies.candidates,
                  admitted: props.workspace.dependencies.admitted,
                  onAdd: props.workspace.dependencies.onAdd,
                }}
                trashed={Boolean(props.workspace.current.ticket.trashedAt)}
                onTrash={props.workspace.onTrash}
                historyAvailable={Boolean(
                  props.workspace.current.revisions.length ||
                    props.workspace.current.documentRevisions.length,
                )}
                historyOpen={props.historyOpen}
                onHistory={props.onToggleHistory}
              />
            </Show>
          }
        />
        <div class="ticket-status-context workspace-heading-meta">
          <span class="ticket-meta-ref">{props.workspace.ticketReference}</span>
          <Show
            when={props.workspace.change}
            fallback={<span>{props.actions.effectiveStatus()}</span>}
          >
            <TicketChecks
              details={props.workspace.delivery}
              fallback={props.actions.effectiveStatus()}
              {...checksFlags()}
            />
          </Show>
          <Show when={props.workspace.change && openThreads() !== undefined}>
            <ReviewThreadStatus count={openThreads() ?? 0} />
          </Show>
          <Show when={visibleTechnicalBadge()}>
            {(badge) => (
              <span class="ticket-meta-accent" role={badge().live ? "status" : undefined}>
                {badge().label}
              </span>
            )}
          </Show>
          <Show when={props.draft.proposal()}>
            <span class="ticket-meta-accent">Review proposal</span>
          </Show>
          <Show when={visibleClarificationStatus()}>
            {(label) => (
              <span class="clarification-status" role="status">
                {label()}
              </span>
            )}
          </Show>
          <Switch>
            <Match when={saveFeedback().kind === "proposal-private"}>
              <Feedback
                class="save-feedback"
                state="idle"
                message="Proposal edits are private until you confirm."
              />
            </Match>
            <Match when={standardSaveFeedback()}>
              {(state) => <SaveFeedback state={state()} />}
            </Match>
          </Switch>
        </div>
        <Show when={visibleProgressBanner()}>
          {(banner) => (
            <p
              class="ticket-progress"
              data-actionable={progressBannerActionable(banner().kind) ? "true" : undefined}
              role="status"
              aria-label="Ticket progress"
            >
              <span id={banner().hasActionReasonId ? "ticket-action-reason" : undefined}>
                {banner().message}
              </span>
            </p>
          )}
        </Show>
        <Show
          when={
            !visibleProgressBanner()?.hasActionReasonId &&
            props.actions.canImplement() &&
            !props.workspace.codingOptionsOpen &&
            props.actions.visibleDisabledReason()
          }
        >
          {(reason) => (
            <p class="ticket-progress" id="ticket-action-reason" data-actionable="true">
              {reason()}
            </p>
          )}
        </Show>
        <Show
          when={
            !props.workspace.current.ticket.trashedAt &&
            props.reviewActions?.revision &&
            (openThreads() ?? 0) > (props.reviewActions.revision.count ?? 0)
          }
        >
          <p class="ticket-progress">
            Comments and Threads awaiting recheck are excluded from the revision.
          </p>
        </Show>
        <Show when={props.workspace.current.proposal && !props.draft.proposal()}>
          <span class="ticket-document-notice workspace-heading-meta" role="status">
            The Ticket changed. Your current text is kept; clarify again for a new proposal.
          </span>
        </Show>
      </div>
      <Switch>
        <Match when={activityNotice().kind === "compute-wait"}>
          <p class="agent-activity-notice" role="status">
            Waiting for execution capacity. Work starts automatically when space is available.
            Source editing remains available.
          </p>
        </Match>
        <Match when={codingPausedMessage()}>
          {(message) => (
            <div class="agent-activity-notice coding-pause-notice" role="status">
              <span>{message()} Existing code is retained.</span>
            </div>
          )}
        </Match>
      </Switch>
      <Show when={props.workspace.current.origin}>
        {(origin) => (
          <button
            type="button"
            class="ticket-related-link"
            onClick={() => props.workspace.onOpenTicket(origin().id)}
          >
            Follow-up to {origin().title}
          </button>
        )}
      </Show>
      <For each={props.workspace.current.followUps}>
        {(ticket) => (
          <button
            type="button"
            class="ticket-related-link"
            onClick={() => props.workspace.onOpenTicket(ticket.id)}
          >
            {ticket.title}
          </button>
        )}
      </For>
      <Show when={props.documentNotice}>
        <div class="ticket-document-notice" role="status">
          <button type="button" onClick={props.onOpenCurrentHistory}>
            Document updated since implementation
          </button>
          <button
            type="button"
            class="bare-icon"
            aria-label="Dismiss document update"
            title="Dismiss document update"
            onClick={props.onDismissDocumentNotice}
          >
            ×
          </button>
        </div>
      </Show>
      <Show
        when={
          props.workspace.change &&
          props.implementationRevision?.approvedAt &&
          props.actions.canEditSpecification() &&
          props.draft.editing()
        }
      >
        <p class="ticket-document-revision-note">
          Edits save as a new revision. Implementation keeps the requirements you approved.
        </p>
      </Show>
    </header>
  );
}
