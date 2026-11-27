import type { ReviewFeedback, VisualReview } from "#conversation-domain/visual-review";
import { APIRequestError } from "../api-client";
import { plainErrorMessage } from "../command-error";
import { serverCall } from "../server-functions/result";
import {
  createReviewFeedback,
  sendReviewRevision,
  updateReviewFeedback,
} from "../server-functions/review";
import { uploadReviewStill } from "./media-client";
import {
  type ComposerPhase,
  initialComposerPhase,
  initialDraftState,
  type ReviewBannerState,
  type ReviewCommandState,
  type ReviewDraftState,
  type ReviewSessionTracker,
  resetComposerAfterSave,
  restoreComposerPhase,
} from "./panel-machine";
import {
  buildFeedbackAnnotation,
  clearPendingCommand,
  getRetainedReviewView,
  hasConflictingStoredCommand,
  matchesPendingCommand,
  pendingCommand,
  persistPendingCommand,
  restorePendingCommand,
  saveRetainedReviewView,
} from "./panel-state";
import type { RecordingStageHandle } from "./recording-stage";

export type PanelCommandContext = {
  changeID: () => string;
  compact: () => boolean;
  commandKey: () => string;
  tracker: ReviewSessionTracker;
  getDraft: () => ReviewDraftState;
  setDraft: (updater: (prev: ReviewDraftState) => ReviewDraftState) => void;
  getComposerPhase: () => ComposerPhase;
  setComposerPhase: (updater: (prev: ComposerPhase) => ComposerPhase) => void;
  setCommandState: (
    next: ReviewCommandState | ((prev: ReviewCommandState) => ReviewCommandState),
  ) => void;
  setBanner: (next: ReviewBannerState | ((prev: ReviewBannerState) => ReviewBannerState)) => void;
  refresh: (fresh?: boolean) => Promise<void>;
  onCaptureCleared: () => void;
};

export function restoreScopeState(options: {
  key: string;
  commandKey: string;
  compact: boolean;
  tracker: ReviewSessionTracker;
}) {
  const retained = getRetainedReviewView(options.key);
  let draft = retained
    ? { body: retained.body, kind: retained.kind, replies: retained.replies }
    : initialDraftState();
  const composerPhase = retained
    ? restoreComposerPhase(retained)
    : initialComposerPhase(options.compact);
  const selectedScenario = retained?.scenario ?? "";
  let commandState: ReviewCommandState = { kind: "idle" };
  let error = "";

  const restored = restorePendingCommand(options.commandKey);
  if (restored.status === "ok") {
    options.tracker.setPending(restored.command);
    commandState = { kind: "unconfirmed", command: restored.command };
    if (restored.command.action === "feedback") {
      const saved = restored.command.input;
      draft = { ...draft, body: saved.body, kind: saved.kind };
    }
    error =
      "An earlier save is unconfirmed. Check the latest review, then retry the same saved request. No work starts automatically.";
  } else if (restored.status === "corrupt") {
    error =
      "A saved review request could not be restored. Check the coding history before sending a new correction.";
  }

  return { draft, composerPhase, selectedScenario, commandState, error };
}

export function persistScopeState(options: {
  key: string;
  draft: ReviewDraftState;
  composerPhase: ComposerPhase;
  selectedScenario: string;
  recordingID: string | undefined;
  currentTime: number;
}) {
  saveRetainedReviewView(options.key, {
    body: options.draft.body,
    kind: options.draft.kind,
    ...(options.composerPhase.capture ? { capture: options.composerPhase.capture } : {}),
    time: options.currentTime,
    ...(options.recordingID ? { recordingID: options.recordingID } : {}),
    scenario: options.selectedScenario,
    composing: options.composerPhase.kind === "open",
    marking: options.composerPhase.kind === "marking",
    position: options.composerPhase.position,
    replies: options.draft.replies,
  });
}

export function mountReviewScope(options: {
  key: string;
  commandKey: string;
  changeID: string;
  compact: boolean;
  isActive: () => boolean;
  tracker: ReviewSessionTracker;
  getDraft: () => ReviewDraftState;
  setDraft: (next: ReviewDraftState) => void;
  getComposerPhase: () => ComposerPhase;
  setComposerPhase: (next: ComposerPhase) => void;
  getSelectedScenario: () => string;
  setSelectedScenario: (next: string) => void;
  setLoadState: (next: { kind: "loading" }) => void;
  setCommandState: (next: ReviewCommandState) => void;
  setBanner: (next: ReviewBannerState | ((prev: ReviewBannerState) => ReviewBannerState)) => void;
  setResolvedOpen: (open: boolean) => void;
  getRecordingID: () => string | undefined;
  getStage: () => RecordingStageHandle | undefined;
  clearStage: () => void;
  refresh: (fresh?: boolean, changeID?: string) => Promise<void>;
}) {
  const scopeEpoch = options.tracker.advanceScope();
  options.clearStage();
  options.setLoadState({ kind: "loading" });
  options.setResolvedOpen(false);
  const restored = restoreScopeState({
    key: options.key,
    commandKey: options.commandKey,
    compact: options.compact,
    tracker: options.tracker,
  });
  options.setDraft(restored.draft);
  options.setComposerPhase(restored.composerPhase);
  options.setSelectedScenario(restored.selectedScenario);
  options.setCommandState(restored.commandState);
  options.setBanner({ error: restored.error, notice: "" });

  void options.refresh(false, options.changeID).catch(() => {
    if (options.tracker.isCurrent(scopeEpoch))
      options.setBanner((prev) => ({
        ...prev,
        error: "Review could not load. Reload review to retry.",
      }));
  });
  const changed = (event: Event) => {
    if ((event as CustomEvent<string>).detail === options.changeID && options.isActive())
      void options.refresh(true).catch(() => {});
  };
  window.addEventListener("factory-review-changed", changed);
  return () => {
    persistScopeState({
      key: options.key,
      draft: options.getDraft(),
      composerPhase: options.getComposerPhase(),
      selectedScenario: options.getSelectedScenario(),
      recordingID: options.getRecordingID(),
      currentTime: options.getStage()?.currentTime() ?? 0,
    });
    options.tracker.invalidateScope();
    options.getStage()?.pause();
    window.removeEventListener("factory-review-changed", changed);
  };
}

export async function executeReviewCommand(
  ctx: PanelCommandContext,
  action: string,
  input: unknown,
): Promise<boolean> {
  if (ctx.tracker.isInFlight()) return false;
  const key = ctx.commandKey();
  const existing = ctx.tracker.pending();
  const setError = (error: string) => ctx.setBanner((prev) => ({ ...prev, error }));
  const setNotice = (notice: string) => ctx.setBanner((prev) => ({ ...prev, notice }));

  if (hasConflictingStoredCommand(key, existing)) {
    setError(
      "Another review view has an unconfirmed request. Check and retry it there before saving new feedback.",
    );
    return false;
  }
  if (existing && !matchesPendingCommand(existing, action, input)) {
    setError(
      "Check the unconfirmed request first. Only its explicit retry can send that saved request.",
    );
    return false;
  }
  if (!ctx.tracker.beginFlight()) return false;
  ctx.setBanner({ error: "", notice: "" });
  const epoch = ctx.tracker.epoch();
  try {
    const current = existing ?? pendingCommand.parse({ action, input });
    ctx.tracker.setPending(current);
    ctx.setCommandState({ kind: "submitting", command: current });
    persistPendingCommand(key, current);
    const changeID = ctx.changeID();
    if (current.action === "feedback")
      await serverCall(createReviewFeedback({ data: [changeID, current.input] }));
    else if (current.action === "update")
      await serverCall(updateReviewFeedback({ data: [changeID, current.input] }));
    else await serverCall(sendReviewRevision({ data: [changeID, current.input] }));
    clearPendingCommand(key);
    if (!ctx.tracker.isCurrent(epoch)) return false;
    ctx.tracker.setPending(undefined);
    ctx.setCommandState({ kind: "idle" });
    if (current.action === "feedback") {
      ctx.setDraft((prev) => ({ ...prev, body: "", kind: "comment" }));
      ctx.setComposerPhase((prev) => resetComposerAfterSave(prev, ctx.compact()));
      ctx.onCaptureCleared();
      setNotice("Saved. No agent work has started.");
    } else if (current.action === "send") {
      setNotice("Revision requested. Threads stay open for your recheck.");
    }
    await ctx.refresh(true).catch(() => {
      if (ctx.tracker.isCurrent(epoch))
        setError("Saved, but the latest review could not load. Reload review to refresh it.");
    });
    window.dispatchEvent(new CustomEvent("factory-review-changed", { detail: changeID }));
    return true;
  } catch (cause) {
    if (ctx.tracker.isCurrent(epoch)) {
      // A confirmed rejection did not admit work. Unknown transport outcomes
      // keep their exact command identity, including across a page reload.
      if (cause instanceof APIRequestError && cause.status >= 400 && cause.status < 500) {
        ctx.tracker.setPending(undefined);
        clearPendingCommand(key);
        ctx.setCommandState({ kind: "idle" });
        void ctx.refresh(true).catch(() => {});
      } else {
        const retainedCommand = ctx.tracker.pending();
        ctx.setCommandState(
          retainedCommand ? { kind: "unconfirmed", command: retainedCommand } : { kind: "idle" },
        );
      }
      setError(
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "Review could not save. Retry the same command.",
      );
    }
    return false;
  } finally {
    ctx.tracker.endFlight(epoch);
  }
}

export async function submitReviewFeedback(ctx: PanelCommandContext, event: SubmitEvent) {
  event.preventDefault();
  if (!ctx.getDraft().body.trim() || ctx.tracker.isInFlight()) return;
  const epoch = ctx.tracker.epoch();
  const frozen = ctx.getComposerPhase().capture;
  let annotation: unknown;
  if (frozen && !ctx.tracker.pending()) {
    if (!ctx.tracker.beginFlight()) return;
    ctx.setCommandState({ kind: "uploading" });
    try {
      let media: { id: string; page?: string | undefined } | undefined;
      if (frozen.frame) {
        try {
          media = await uploadReviewStill(ctx.changeID(), {
            id: frozen.id,
            frame: frozen.frame,
            context: frozen.context,
          });
        } catch (cause) {
          if (frozen.context.source === "recording") throw cause;
          ctx.setBanner((prev) => ({
            ...prev,
            notice: "Context image could not save. The Preview anchor is retained.",
          }));
        }
      }
      if (!ctx.tracker.isCurrent(epoch)) return;
      annotation = buildFeedbackAnnotation(frozen, media);
    } catch (cause) {
      if (ctx.tracker.isCurrent(epoch))
        ctx.setBanner((prev) => ({
          ...prev,
          error:
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "Original frame could not save. Your comment is retained.",
        }));
      return;
    } finally {
      ctx.tracker.endFlight(epoch);
      if (ctx.tracker.isCurrent(epoch))
        ctx.setCommandState((prev) => (prev.kind === "uploading" ? { kind: "idle" } : prev));
    }
  }
  const submitted = ctx.getDraft();
  if (
    await executeReviewCommand(ctx, "feedback", {
      commandId: crypto.randomUUID(),
      kind: submitted.kind,
      body: submitted.body,
      ...(annotation ? { annotation } : {}),
    })
  )
    ctx.setDraft((prev) => ({ ...prev, body: "" }));
}

export async function focusFeedbackEntry(
  item: ReviewFeedback,
  view: VisualReview | undefined,
  stage: RecordingStageHandle | undefined,
  surface: HTMLElement | undefined,
) {
  stage?.pause();
  await stage?.exitFullscreen();
  const annotation = item.annotation;
  if (annotation?.source === "recording" && annotation.recordingId === view?.recording?.id) {
    stage?.pause();
    stage?.seek(annotation.timestampMs / 1000);
  }
  const entry = surface?.querySelector<HTMLElement>(`#review-feedback-${item.id}`);
  const fold = entry?.closest<HTMLDetailsElement>(".review-resolved");
  if (fold) fold.open = true;
  entry?.scrollIntoView({ block: "nearest" });
  entry?.focus({ preventScroll: true });
}

export function seekFeedbackOnStage(
  item: ReviewFeedback,
  recordingID: string | undefined,
  stage: RecordingStageHandle | undefined,
) {
  const annotation = item.annotation;
  if (annotation?.source !== "recording" || annotation.recordingId !== recordingID || !stage)
    return;
  stage.pause();
  stage.seek(annotation.timestampMs / 1000);
  stage.scrollIntoView();
}
