import type { VisualReview } from "#conversation-domain/visual-review";
import type { PanelReviewCapture, PendingReviewCommand, RetainedReviewView } from "./panel-state";

export type ComposerPosition = { x: number; y: number };

export type ReviewLoadState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; view: VisualReview };

export type ComposerPhase =
  | { kind: "closed"; position: ComposerPosition; capture?: PanelReviewCapture | undefined }
  | { kind: "marking"; position: ComposerPosition; capture: PanelReviewCapture }
  | { kind: "open"; position: ComposerPosition; capture?: PanelReviewCapture | undefined };

export type ReviewCommandState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "submitting"; command: PendingReviewCommand }
  | { kind: "unconfirmed"; command: PendingReviewCommand };

export type ReviewDraftState = {
  body: string;
  kind: "comment" | "thread";
  replies: Record<string, string>;
};

export type ReviewBannerState = {
  error: string;
  notice: string;
};

export type RecordingMediaState =
  | { kind: "loading"; playhead: number; duration: number; ratio: number }
  | { kind: "ready"; paused: boolean; playhead: number; duration: number; ratio: number }
  | { kind: "failed"; playhead: number; duration: number; ratio: number };

export function initialDraftState(): ReviewDraftState {
  return { body: "", kind: "comment", replies: {} };
}

export function initialComposerPhase(compact: boolean): ComposerPhase {
  return { kind: compact ? "open" : "closed", position: { x: 12, y: 12 } };
}

export function restoreComposerPhase(retained: RetainedReviewView): ComposerPhase {
  if (retained.marking && retained.capture)
    return { kind: "marking", position: retained.position, capture: retained.capture };
  if (retained.composing)
    return { kind: "open", position: retained.position, capture: retained.capture };
  return { kind: "closed", position: retained.position, capture: retained.capture };
}

export function openComposerWithCapture(
  prev: ComposerPhase,
  capture: PanelReviewCapture,
): ComposerPhase {
  return { kind: "open", position: prev.position, capture };
}

export function startVideoMarking(prev: ComposerPhase, capture: PanelReviewCapture): ComposerPhase {
  return { kind: "marking", position: prev.position, capture };
}

// A cancelled selection keeps no captured frame; a stale one would otherwise seed the next composer.
export function cancelVideoMarking(prev: ComposerPhase): ComposerPhase {
  return prev.kind === "marking" ? { kind: "closed", position: prev.position } : prev;
}

export function selectVideoFramePoint(
  prev: ComposerPhase,
  x: number,
  y: number,
  position: ComposerPosition,
): ComposerPhase {
  return {
    kind: "open",
    position,
    capture: prev.capture
      ? { ...prev.capture, region: { x, y, width: 0.001, height: 0.001 } }
      : undefined,
  };
}

export function openComposerAt(
  prev: ComposerPhase,
  position: ComposerPosition,
  keepCapture: boolean,
): ComposerPhase {
  return { kind: "open", position, capture: keepCapture ? prev.capture : undefined };
}

export function openComposerKeepingPosition(prev: ComposerPhase): ComposerPhase {
  return { kind: "open", position: prev.position, capture: prev.capture };
}

export function dismissComposer(prev: ComposerPhase): ComposerPhase {
  return { kind: "closed", position: prev.position, capture: prev.capture };
}

export function cancelComposer(prev: ComposerPhase): ComposerPhase {
  return { kind: "closed", position: prev.position };
}

export function resetComposerAfterSave(prev: ComposerPhase, compact: boolean): ComposerPhase {
  return { kind: compact ? "open" : "closed", position: prev.position };
}

export function reviewViewOf(state: ReviewLoadState): VisualReview | undefined {
  return state.kind === "loaded" ? state.view : undefined;
}

export function markReviewLoadFailed(prev: ReviewLoadState): ReviewLoadState {
  return prev.kind === "loaded" ? prev : { kind: "failed" };
}

export function isCommandBusy(state: ReviewCommandState): boolean {
  return state.kind === "uploading" || state.kind === "submitting";
}

export function isCommandLocked(state: ReviewCommandState): boolean {
  return state.kind !== "idle";
}

export function isSendingRevision(state: ReviewCommandState): boolean {
  return state.kind === "submitting" && state.command.action === "send";
}

export function pendingRetryCommand(state: ReviewCommandState): PendingReviewCommand | undefined {
  return state.kind === "unconfirmed" || state.kind === "submitting" ? state.command : undefined;
}

export function initialMediaState(): RecordingMediaState {
  return { kind: "loading", playhead: 0, duration: 0, ratio: 16 / 9 };
}

export function resetMediaForRecording(prev: RecordingMediaState): RecordingMediaState {
  return { kind: "loading", playhead: prev.playhead, duration: 0, ratio: prev.ratio };
}

export function updateMediaMetadata(
  prev: RecordingMediaState,
  duration: number,
  ratio: number | undefined,
): RecordingMediaState {
  return { ...prev, duration, ratio: ratio ?? prev.ratio };
}

export function markMediaLoaded(
  prev: RecordingMediaState,
  playhead: number,
  duration: number,
  ratio: number | undefined,
): RecordingMediaState {
  return {
    kind: "ready",
    paused: prev.kind === "ready" ? prev.paused : true,
    playhead,
    duration,
    ratio: ratio ?? prev.ratio,
  };
}

export function setMediaPaused(prev: RecordingMediaState, paused: boolean): RecordingMediaState {
  return prev.kind === "ready" ? { ...prev, paused } : prev;
}

export function setMediaPlayhead(prev: RecordingMediaState, playhead: number): RecordingMediaState {
  return { ...prev, playhead };
}

export function markMediaFailed(prev: RecordingMediaState): RecordingMediaState {
  return { kind: "failed", playhead: prev.playhead, duration: prev.duration, ratio: prev.ratio };
}

export type ReviewSessionTracker = ReturnType<typeof createReviewSessionTracker>;

export function createReviewSessionTracker() {
  const state = {
    generation: 0,
    inFlight: false,
    readSequence: 0,
    pendingRead: undefined as Promise<void> | undefined,
    retry: undefined as PendingReviewCommand | undefined,
  };

  return {
    epoch: () => state.generation,
    isCurrent: (epoch: number) => epoch === state.generation,
    advanceScope() {
      const next = ++state.generation;
      state.pendingRead = undefined;
      state.retry = undefined;
      state.inFlight = false;
      return next;
    },
    invalidateScope() {
      state.generation++;
    },
    pending: () => state.retry,
    setPending(command: PendingReviewCommand | undefined) {
      state.retry = command;
    },
    isInFlight: () => state.inFlight,
    beginFlight() {
      if (state.inFlight) return false;
      state.inFlight = true;
      return true;
    },
    endFlight(epoch: number) {
      if (epoch === state.generation) state.inFlight = false;
    },
    runRead(
      fresh: boolean,
      fetchView: () => Promise<VisualReview>,
      onSuccess: (result: VisualReview) => void,
      onFail: () => void,
    ): Promise<void> {
      // A slow read must still be publishable when the next poll ticks. Commands
      // and explicit cross-view changes supersede reads begun before their save.
      if (state.pendingRead && !fresh) return state.pendingRead;
      const epoch = state.generation;
      const sequence = ++state.readSequence;
      const request = (async () => {
        let result: VisualReview;
        try {
          result = await fetchView();
        } catch (cause) {
          if (epoch === state.generation && sequence === state.readSequence) onFail();
          throw cause;
        }
        if (epoch !== state.generation || sequence !== state.readSequence) return;
        onSuccess(result);
      })();
      state.pendingRead = request;
      const settled = () => {
        if (state.pendingRead === request) state.pendingRead = undefined;
      };
      void request.then(settled, settled);
      return request;
    },
  };
}
