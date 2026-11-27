import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { pendingReviewThreads, type ReviewFeedback } from "#conversation-domain/visual-review";
import { serverCall } from "../server-functions/result";
import { getVisualReview } from "../server-functions/review";
import { observeFactoryRead } from "../zero/reads";
import { reviewMediaURL } from "./media-client";
import { ReviewPanelBody } from "./panel-body";
import {
  executeReviewCommand,
  focusFeedbackEntry,
  mountReviewScope,
  type PanelCommandContext,
  seekFeedbackOnStage,
  submitReviewFeedback,
} from "./panel-commands";
import * as machine from "./panel-machine";
import {
  ReviewPanelComposerPlacement,
  ReviewPanelHeader,
  ReviewPanelStatus,
} from "./panel-sections";
import {
  calculateAddFeedbackPosition,
  countOpenThreads,
  type PanelReviewCapture,
  reviewCommandKey,
  reviewViewKey,
} from "./panel-state";
import type { RecordingStageHandle } from "./recording-stage";
import "./review.css";

export type ReviewRevisionAction = {
  count: number;
  disabled: boolean;
  sending: boolean;
  request(): void;
};

export type ReviewActions = {
  revision: ReviewRevisionAction | undefined;
  addFeedback: (() => void) | undefined;
  reload(): void;
};

export function ReviewThreadStatus(props: { count: number }) {
  return (
    <span class="review-thread-count" role="status">
      {props.count
        ? `${props.count} open ${props.count === 1 ? "Thread blocks" : "Threads block"} Delivery`
        : "No open Threads"}
    </span>
  );
}

export type ReviewCapture = PanelReviewCapture;

export function ReviewPanel(props: {
  changeID: string;
  userID: string;
  canDevelop: boolean;
  readOnly?: boolean;
  capture?: ReviewCapture | undefined;
  onCaptureCleared?: () => void;
  onThreadCount?: (count: number) => void;
  compact?: boolean;
  viewID?: string;
  feedbackID?: string | undefined;
  active?: boolean | undefined;
  projectID?: string | undefined;
  onFeedback?(feedback: ReviewFeedback[], readOnly: boolean): void;
  onDraftChange?(dirty: boolean): void;
  onClose?(): void;
  onOpenPreview?: (() => void) | undefined;
  onActions?(actions: Accessor<ReviewActions | undefined> | undefined): void;
}) {
  const [loadState, setLoadState] = createSignal<machine.ReviewLoadState>({ kind: "loading" });
  const [commandState, setCommandState] = createSignal<machine.ReviewCommandState>({
    kind: "idle",
  });
  const [composerPhase, setComposerPhase] = createSignal<machine.ComposerPhase>(
    machine.initialComposerPhase(untrack(() => Boolean(props.compact))),
  );
  const [draft, setDraft] = createSignal<machine.ReviewDraftState>(machine.initialDraftState());
  const [banner, setBanner] = createSignal<machine.ReviewBannerState>({ error: "", notice: "" });
  const [resolvedOpen, setResolvedOpen] = createSignal(false);
  const [selectedScenario, setSelectedScenario] = createSignal("");
  const [frameURL, setFrameURL] = createSignal("");
  const tracker = machine.createReviewSessionTracker();
  let surface: HTMLElement | undefined;
  let stage: RecordingStageHandle | undefined;

  const view = () => machine.reviewViewOf(loadState());
  const commandKey = () => reviewCommandKey(props.userID, props.changeID);
  const viewKey = () =>
    reviewViewKey(props.userID, props.changeID, Boolean(props.compact), props.viewID);
  const mediaURL = (id: string) => reviewMediaURL(props.changeID, id);
  const readOnly = () => Boolean(props.readOnly || view()?.readOnly);
  const capturedBlob = createMemo(() => composerPhase().capture?.frame);
  const visibleFeedback = () =>
    view()?.feedback.filter((item) => !props.compact || item.id === props.feedbackID) ?? [];
  const scopeIdentity = createMemo(viewKey);
  const setError = (error: string) => setBanner((prev) => ({ ...prev, error }));
  const setNotice = (notice: string) => setBanner((prev) => ({ ...prev, notice }));

  const refresh = (fresh = false, changeID = props.changeID): Promise<void> =>
    tracker.runRead(
      fresh,
      () => serverCall(getVisualReview({ data: [changeID] })),
      (result) => {
        setLoadState({ kind: "loaded", view: result });
        props.onThreadCount?.(countOpenThreads(result.feedback));
        props.onFeedback?.(result.feedback, Boolean(result.readOnly));
      },
      () => setLoadState(machine.markReviewLoadFailed),
    );

  const commandContext: PanelCommandContext = {
    changeID: () => props.changeID,
    compact: () => Boolean(props.compact),
    commandKey,
    tracker,
    getDraft: draft,
    setDraft,
    getComposerPhase: composerPhase,
    setComposerPhase,
    setCommandState,
    setBanner,
    refresh,
    onCaptureCleared: () => props.onCaptureCleared?.(),
  };

  createEffect(
    () => draft().body,
    (value) => props.onDraftChange?.(Boolean(value.trim())),
  );

  // Reset only for a new view identity, not when its current Change snapshot updates.
  createEffect(
    () => {
      const key = scopeIdentity();
      return untrack(() => ({
        key,
        commandKey: commandKey(),
        changeID: props.changeID,
        compact: Boolean(props.compact),
      }));
    },
    (scope) =>
      mountReviewScope({
        ...scope,
        isActive: () => props.active !== false,
        tracker,
        getDraft: draft,
        setDraft,
        getComposerPhase: composerPhase,
        setComposerPhase,
        getSelectedScenario: selectedScenario,
        setSelectedScenario,
        setLoadState,
        setCommandState,
        setBanner,
        setResolvedOpen,
        getRecordingID: () => view()?.recording?.id,
        getStage: () => stage,
        clearStage: () => {
          stage = undefined;
        },
        refresh,
      }),
  );

  observeFactoryRead(
    () =>
      props.projectID && props.active !== false
        ? { projectId: props.projectID, scope: "review", resourceId: props.changeID }
        : null,
    () => refresh(true),
    () => setLoadState(machine.markReviewLoadFailed),
  );

  createEffect(
    () => props.capture,
    (value) => {
      if (!value) return;
      setComposerPhase((prev) => machine.openComposerWithCapture(prev, value));
      setNotice("");
    },
  );
  createEffect(
    () => props.feedbackID,
    () => {
      setNotice("");
    },
  );
  createEffect(capturedBlob, (value) => {
    if (!value) {
      setFrameURL("");
      return;
    }
    const url = URL.createObjectURL(value);
    setFrameURL(url);
    return () => URL.revokeObjectURL(url);
  });
  createEffect(
    () => props.active,
    (active) => {
      if (active === false) stage?.pause();
      else if (props.compact && !props.feedbackID)
        setComposerPhase(machine.openComposerKeepingPosition);
    },
  );

  const pendingThreads = () => pendingReviewThreads(view()?.feedback ?? []);
  const revisionAction = createMemo<ReviewRevisionAction | undefined>(() =>
    !props.compact && !readOnly() && pendingThreads().length
      ? {
          count: pendingThreads().length,
          disabled: machine.isCommandLocked(commandState()) || view()?.canSendCorrections === false,
          sending: machine.isSendingRevision(commandState()),
          request: () => {
            void executeReviewCommand(commandContext, "send", {
              commandId: crypto.randomUUID(),
              feedback: pendingThreads().map((item) => ({ id: item.id, version: item.version })),
            });
          },
        }
      : undefined,
  );
  const canAddFeedback = () => Boolean(view()) && !readOnly();
  const showComposer = () =>
    composerPhase().kind === "open" && (!props.compact || !props.feedbackID) && !readOnly();

  async function reloadReview() {
    setError("");
    if (loadState().kind === "failed") setLoadState({ kind: "loading" });
    await refresh().catch(() => setError("Review could not load. Reload review to retry."));
  }

  function addFeedback() {
    if (!canAddFeedback()) {
      setError(
        readOnly()
          ? "This review is read-only."
          : "Review is unavailable. Reload review before adding feedback.",
      );
      return;
    }
    const hasBody = Boolean(draft().body.trim());
    if (composerPhase().kind === "open" && hasBody) return;
    if (!hasBody) setDraft((prev) => ({ ...prev, kind: "comment" }));
    setComposerPhase((prev) =>
      machine.openComposerAt(prev, calculateAddFeedbackPosition(surface?.clientWidth), hasBody),
    );
  }

  const actions = createMemo<ReviewActions | undefined>(() =>
    props.compact
      ? undefined
      : {
          revision: revisionAction(),
          addFeedback: canAddFeedback() ? addFeedback : undefined,
          reload: () => void reloadReview(),
        },
  );
  onSettled(() => {
    const publish = untrack(() => props.onActions);
    publish?.(actions);
    return () => publish?.(undefined);
  });

  const composerPlacement = () => (
    <ReviewPanelComposerPlacement
      changeID={props.changeID}
      compact={Boolean(props.compact)}
      active={props.active !== false && showComposer()}
      hasView={Boolean(view())}
      draft={draft()}
      composerPhase={composerPhase()}
      commandState={commandState()}
      frameURL={frameURL()}
      setDraft={setDraft}
      setComposerPhase={setComposerPhase}
      onSubmit={(event) => void submitReviewFeedback(commandContext, event)}
      onCaptureCleared={props.onCaptureCleared}
      onClose={props.onClose}
    />
  );

  return (
    <section
      ref={surface}
      class={`visual-review ${props.compact ? "compact" : ""}${!props.compact && loadState().kind === "loading" ? " is-loading" : ""}`}
      aria-label="Visual review"
    >
      <ReviewPanelHeader
        compact={Boolean(props.compact)}
        hasExternalActions={Boolean(props.onActions)}
        showThreadStatus={!props.onThreadCount && Boolean(view())}
        openCount={countOpenThreads(view()?.feedback ?? [])}
        readOnly={readOnly()}
        hasView={Boolean(view())}
        loadFailed={loadState().kind === "failed"}
        canAddFeedback={canAddFeedback()}
        feedbackID={props.feedbackID}
        revision={revisionAction()}
        onReload={() => void reloadReview()}
        onOpenPreview={props.onOpenPreview}
        onAddFeedback={addFeedback}
      />
      <ReviewPanelStatus
        banner={banner()}
        commandState={commandState()}
        onRetry={(pending) =>
          void executeReviewCommand(commandContext, pending.action, pending.input)
        }
      />
      <ReviewPanelBody
        state={{
          loadState: loadState(),
          commandState: commandState(),
          composerPhase: composerPhase(),
          draft: draft(),
          selectedScenario: selectedScenario(),
          resolvedOpen: resolvedOpen(),
          showComposer: showComposer(),
          visibleFeedback: visibleFeedback(),
        }}
        compact={Boolean(props.compact)}
        hasExternalActions={Boolean(props.onActions)}
        viewKey={viewKey()}
        active={props.active}
        readOnly={readOnly()}
        feedbackID={props.feedbackID}
        userID={props.userID}
        canDevelop={props.canDevelop}
        mediaURL={mediaURL}
        surfaceRect={() => surface?.getBoundingClientRect()}
        composer={composerPlacement}
        onReload={() => void reloadReview()}
        setComposerPhase={setComposerPhase}
        onSelectedScenario={setSelectedScenario}
        onFocusFeedback={(item) => void focusFeedbackEntry(item, view(), stage, surface)}
        onError={setError}
        onStageReady={(handle) => {
          stage = handle;
        }}
        onResolvedOpen={setResolvedOpen}
        setDraft={setDraft}
        onSeek={(item, currentView) => seekFeedbackOnStage(item, currentView.recording?.id, stage)}
        commandContext={commandContext}
      />
      <Show when={props.compact && showComposer()}>{composerPlacement()}</Show>
    </section>
  );
}
