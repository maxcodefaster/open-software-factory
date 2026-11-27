import { For, Show } from "solid-js";
import type { ReviewFeedback, VisualReview } from "#conversation-domain/visual-review";
import { TicketActionBar } from "../tickets/ticket-action-bar";
import { ReviewComposer } from "./composer";
import { FeedbackItem } from "./feedback-item";
import {
  type ComposerPhase,
  cancelComposer,
  dismissComposer,
  isCommandBusy,
  isCommandLocked,
  pendingRetryCommand,
  type ReviewBannerState,
  type ReviewCommandState,
  type ReviewDraftState,
} from "./panel-machine";
import { composerSourceLabel, isFeedbackSeekable, type PendingReviewCommand } from "./panel-state";

export type PanelRevisionSummary = {
  count: number;
  disabled: boolean;
  sending: boolean;
  request(): void;
};

export function ReviewPanelHeader(props: {
  compact: boolean;
  hasExternalActions: boolean;
  showThreadStatus: boolean;
  openCount: number;
  readOnly: boolean;
  hasView: boolean;
  loadFailed: boolean;
  canAddFeedback: boolean;
  feedbackID: string | undefined;
  revision: PanelRevisionSummary | undefined;
  onReload(): void;
  onOpenPreview?: (() => void) | undefined;
  onAddFeedback(): void;
}) {
  const revisionActions = () => {
    const action = props.revision;
    return action
      ? [
          {
            id: "revision",
            label: `${action.sending ? "Requesting revision…" : "Request revision"} · ${action.count} ${action.count === 1 ? "Thread" : "Threads"}`,
            disabled: action.disabled,
            title: `Revise ${action.count} eligible open ${action.count === 1 ? "Thread" : "Threads"}. Comments and Threads awaiting recheck are excluded.`,
            primary: true,
            run: () => props.revision?.request(),
          },
        ]
      : [];
  };
  return (
    <header class={`review-heading ${props.hasExternalActions ? "sr-only" : ""}`}>
      <div>
        <h3 class={!props.compact ? "sr-only" : ""}>
          {props.compact ? (props.feedbackID ? "Feedback" : "Comment on Preview") : "Review"}
        </h3>
        <Show when={props.showThreadStatus}>
          <span class="review-thread-count" role="status">
            {props.openCount
              ? `${props.openCount} open ${props.openCount === 1 ? "Thread blocks" : "Threads block"} Delivery`
              : "No open Threads"}
          </span>
        </Show>
      </div>
      <Show when={!props.compact && !props.hasExternalActions}>
        <TicketActionBar
          actions={[
            { id: "reload", label: "Reload review", run: props.onReload },
            ...(props.onOpenPreview
              ? [{ id: "preview", label: "Open Live Preview", run: props.onOpenPreview }]
              : []),
            ...(!props.readOnly
              ? [
                  {
                    id: "feedback",
                    label: "Add feedback",
                    disabled: !props.canAddFeedback,
                    title: !props.hasView
                      ? props.loadFailed
                        ? "Reload review before adding feedback."
                        : "Wait for review to load before adding feedback."
                      : undefined,
                    run: props.onAddFeedback,
                  },
                ]
              : []),
            ...revisionActions(),
          ]}
        />
      </Show>
    </header>
  );
}

export function ReviewPanelStatus(props: {
  banner: ReviewBannerState;
  commandState: ReviewCommandState;
  onRetry(command: PendingReviewCommand): void;
}) {
  const retry = () => pendingRetryCommand(props.commandState);
  return (
    <>
      <Show when={props.banner.error}>
        <p role="alert" class="review-error">
          {props.banner.error}{" "}
          <Show when={retry()}>
            {(pending) => (
              <button
                type="button"
                disabled={isCommandBusy(props.commandState)}
                onClick={() => props.onRetry(pending())}
              >
                {pending().action === "send" ? "Retry correction request" : "Retry save"}
              </button>
            )}
          </Show>
        </p>
      </Show>
      <Show when={props.banner.notice}>
        <p role="status">{props.banner.notice}</p>
      </Show>
    </>
  );
}

export function ReviewPanelComposerPlacement(props: {
  changeID: string;
  compact: boolean;
  active: boolean;
  hasView: boolean;
  draft: ReviewDraftState;
  composerPhase: ComposerPhase;
  commandState: ReviewCommandState;
  frameURL: string;
  setDraft(updater: (prev: ReviewDraftState) => ReviewDraftState): void;
  setComposerPhase(updater: (prev: ComposerPhase) => ComposerPhase): void;
  onSubmit(event: SubmitEvent): void;
  onCaptureCleared?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  const capture = () => props.composerPhase.capture;
  return (
    <div
      class={`review-composer-placement ${!props.compact ? "is-floating" : ""}`}
      style={
        !props.compact
          ? {
              "--review-composer-x": `${props.composerPhase.position.x}px`,
              "--review-composer-y": `${props.composerPhase.position.y}px`,
            }
          : undefined
      }
    >
      <ReviewComposer
        attachmentScopeKey={`feedback:${props.changeID}:new`}
        body={props.draft.body}
        kind={props.draft.kind}
        busy={isCommandBusy(props.commandState)}
        locked={Boolean(pendingRetryCommand(props.commandState)) || !props.hasView}
        source={composerSourceLabel(capture())}
        image={capture()?.frame ? props.frameURL || undefined : undefined}
        reconstructed={capture()?.context.source === "preview"}
        onBody={(body) => props.setDraft((prev) => ({ ...prev, body }))}
        onKind={(kind) => props.setDraft((prev) => ({ ...prev, kind }))}
        active={props.active}
        reveal={!props.compact && matchMedia("(max-width: 780px)").matches}
        onSubmit={props.onSubmit}
        onDismiss={() => {
          props.setComposerPhase(dismissComposer);
          props.onClose?.();
        }}
        onCancel={() => {
          props.setDraft((prev) => ({ ...prev, body: "" }));
          props.setComposerPhase(cancelComposer);
          props.onCaptureCleared?.();
          props.onClose?.();
        }}
      />
    </div>
  );
}

export function ReviewFeedbackList(props: {
  view: VisualReview;
  visibleFeedback: ReviewFeedback[];
  compact: boolean;
  feedbackID: string | undefined;
  userID: string;
  canDevelop: boolean;
  readOnly: boolean;
  commandState: ReviewCommandState;
  replies: Record<string, string>;
  resolvedOpen: boolean;
  mediaURL(id: string): string;
  onResolvedOpen(open: boolean): void;
  onReply(feedbackID: string, value: string): void;
  onSeek(item: ReviewFeedback): void;
  onAction(item: ReviewFeedback, action: string, reply?: string): Promise<boolean>;
}) {
  const feedbackRow = (item: () => ReviewFeedback) => (
    <FeedbackItem
      item={item()}
      mediaURL={props.mediaURL}
      readOnly={props.readOnly}
      canResolve={props.canDevelop || props.userID === item().authorId}
      busy={isCommandLocked(props.commandState)}
      previous={Boolean(
        props.view.currentCommitSha && item().commitSha !== props.view.currentCommitSha,
      )}
      pinLabel={String(props.view.feedback.findIndex((entry) => entry.id === item().id) + 1)}
      reply={props.replies[item().id] ?? ""}
      onReply={(value) => props.onReply(item().id, value)}
      canSeek={isFeedbackSeekable(item(), props.view)}
      onSeek={() => props.onSeek(item())}
      onAction={(action, reply) => props.onAction(item(), action, reply)}
    />
  );

  return (
    <div class="review-feedback-list">
      <Show
        when={props.visibleFeedback.length}
        fallback={
          <p class="review-empty">
            {props.compact
              ? props.feedbackID
                ? "This feedback is no longer available."
                : ""
              : "No feedback yet. Add general feedback or comment on the QA recording or Live Preview."}
          </p>
        }
      >
        <For
          each={props.visibleFeedback.filter(
            (item) => item.kind === "thread" && item.state !== "resolved",
          )}
          keyed={(item) => item.id}
        >
          {feedbackRow}
        </For>
        <For
          each={props.visibleFeedback.filter((item) => item.kind === "comment")}
          keyed={(item) => item.id}
        >
          {feedbackRow}
        </For>
        <Show when={props.visibleFeedback.some((item) => item.state === "resolved")}>
          <details
            class="review-resolved"
            open={
              props.resolvedOpen ||
              props.compact ||
              props.visibleFeedback.some(
                (item) => item.id === props.feedbackID && item.state === "resolved",
              )
            }
            onToggle={(event) => props.onResolvedOpen(event.currentTarget.open)}
          >
            <summary>
              Resolved ({props.visibleFeedback.filter((item) => item.state === "resolved").length})
            </summary>
            <For
              each={props.visibleFeedback.filter((item) => item.state === "resolved")}
              keyed={(item) => item.id}
            >
              {feedbackRow}
            </For>
          </details>
        </Show>
      </Show>
    </div>
  );
}
