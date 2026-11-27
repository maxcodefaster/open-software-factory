import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { ReviewFeedback, VisualReview } from "#conversation-domain/visual-review";
import {
  initialMediaState,
  markMediaFailed,
  markMediaLoaded,
  type RecordingMediaState,
  resetMediaForRecording,
  setMediaPaused,
  setMediaPlayhead,
  updateMediaMetadata,
} from "./panel-machine";
import {
  buildWebVttCaptions,
  type PanelReviewCapture,
  recordingEmptyMessage,
  shouldPreservePausedScenario,
} from "./panel-state";
import { scenarioAt } from "./playback";
import { ReviewPlayerControls } from "./player-controls";
import {
  captureRecordingFrame,
  readVideoMetrics,
  restoreRetainedPlayhead,
} from "./recording-capture";
import { RecordingScenarioSummary, RecordingSurfaceOverlays } from "./recording-scenarios";

export type RecordingStageHandle = {
  pause(): void;
  currentTime(): number;
  seek(seconds: number, scenarioID?: string): void;
  scrollIntoView(): void;
  exitFullscreen(): Promise<void>;
};

export function RecordingStage(props: {
  view: VisualReview;
  viewKey: string;
  mediaURL(id: string): string;
  active?: boolean | undefined;
  readOnly: boolean;
  locked: boolean;
  hasDraftBody: boolean;
  markingVideo: boolean;
  selectedScenario: string;
  showRecordingComposer: boolean;
  composer?: JSX.Element;
  onCancelMarking(): void;
  onSelectedScenario(id: string): void;
  onOpenComposer(): void;
  onCapturedFrame(capture: PanelReviewCapture): void;
  onSelectFramePoint(x: number, y: number, rect: DOMRect): void;
  onFocusFeedback(item: ReviewFeedback): void;
  onError(message: string): void;
  onStageReady(handle: RecordingStageHandle): void;
}) {
  const [media, setMedia] = createSignal<RecordingMediaState>(initialMediaState());
  const [fullscreen, setFullscreen] = createSignal(false);
  const [captionsURL, setCaptionsURL] = createSignal("");
  let video: HTMLVideoElement | undefined;
  let player: HTMLDivElement | undefined;
  let commentButton: HTMLButtonElement | undefined;
  let restoredRecording: string | undefined;

  const videoReady = () => media().kind === "ready";
  const videoFailed = () => media().kind === "failed";
  const paused = () => {
    const state = media();
    return state.kind === "ready" ? state.paused : true;
  };
  const playhead = () => media().playhead;
  const duration = () => media().duration;

  const recordingIdentity = createMemo(() => props.view.recording?.id);
  const recordingSource = createMemo(() => {
    const id = recordingIdentity();
    return id ? props.mediaURL(id) : undefined;
  });
  const completedRecording = createMemo(() => {
    const recording = props.view.recording;
    return recording?.state === "complete" ? { view: props.view, recording } : undefined;
  });

  createEffect(recordingIdentity, () => {
    setMedia(resetMediaForRecording);
    restoredRecording = undefined;
  });

  const captionPayload = createMemo(() =>
    JSON.stringify({
      scenarios: props.view.scenarios,
      duration: props.view.recording?.durationMs ?? 0,
    }),
  );
  createEffect(captionPayload, (value) => {
    const { scenarios, duration: durationMs } = JSON.parse(value) as {
      scenarios: VisualReview["scenarios"];
      duration: number;
    };
    const url = URL.createObjectURL(
      new Blob([buildWebVttCaptions(scenarios, durationMs)], { type: "text/vtt" }),
    );
    setCaptionsURL(url);
    return () => URL.revokeObjectURL(url);
  });

  createEffect(
    () => props.active,
    (active) => {
      if (active === false) video?.pause();
    },
  );

  const pauseHidden = () => {
    if (document.visibilityState === "hidden") video?.pause();
  };
  const fullscreenChanged = () => setFullscreen(document.fullscreenElement === player);
  document.addEventListener("visibilitychange", pauseHidden);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", pauseHidden);
    document.removeEventListener("fullscreenchange", fullscreenChanged);
  });

  const syncPlayhead = () => {
    if (!video) return;
    setMedia((prev) => setMediaPlayhead(prev, video?.currentTime ?? 0));
    const selected = props.view.scenarios.find((item) => item.id === props.selectedScenario);
    if (video.paused && shouldPreservePausedScenario(selected, video.currentTime)) return;
    props.onSelectedScenario(scenarioAt(props.view.scenarios, video.currentTime)?.id ?? "");
  };

  const seek = (seconds: number, scenarioID?: string) => {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration(), seconds));
    setMedia((prev) => setMediaPlayhead(prev, video?.currentTime ?? 0));
    // Apply the seek intent directly. A state reread in this same event can
    // still see the preceding selection; later media events sync playback.
    props.onSelectedScenario(
      scenarioID ?? scenarioAt(props.view.scenarios, video.currentTime)?.id ?? "",
    );
  };

  props.onStageReady({
    pause: () => video?.pause(),
    currentTime: () => video?.currentTime ?? 0,
    seek,
    scrollIntoView: () => video?.scrollIntoView({ block: "nearest" }),
    exitFullscreen: async () => {
      if (document.fullscreenElement === player) await document.exitFullscreen().catch(() => {});
    },
  });

  const cancelMarkingOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !props.markingVideo) return;
    event.preventDefault();
    event.stopPropagation();
    props.onCancelMarking();
    // The selection overlay disappears with the mode, so keep keyboard focus on the Comment button.
    commentButton?.focus();
  };

  const togglePlayback = () => {
    if (!video || !duration() || videoFailed()) return;
    if (!video.paused) video.pause();
    else {
      props.onSelectedScenario(scenarioAt(props.view.scenarios, video.currentTime)?.id ?? "");
      if (video.ended) seek(0);
      void video
        .play()
        .catch(() => props.onError("Playback could not start. Press Play to try again."));
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else await player?.requestFullscreen();
    } catch {
      props.onError("Full screen is unavailable. You can still review the recording here.");
    }
  };

  return (
    <div class="review-recording">
      <div
        class="review-player"
        ref={player}
        style={{ "--review-video-ratio": String(media().ratio) }}
      >
        <div class={`review-recording-surface ${props.markingVideo ? "is-marking" : ""}`}>
          <Show
            when={props.view.recording?.state === "complete"}
            fallback={
              <div class="review-video-empty">
                <h4>QA recording</h4>
                <p>{recordingEmptyMessage(props.view.recording)}</p>
                <p>Video availability does not change the QA result.</p>
              </div>
            }
          >
            <video
              ref={video}
              preload="metadata"
              playsinline
              src={recordingSource()}
              aria-label="QA recording"
              tabindex="0"
              onClick={togglePlayback}
              onKeyDown={(event) => {
                if (event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === " " || event.key.toLowerCase() === "k") {
                  event.preventDefault();
                  togglePlayback();
                } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  seek(playhead() + (event.key === "ArrowRight" ? 5 : -5));
                } else if (event.key.toLowerCase() === "f") {
                  event.preventDefault();
                  void toggleFullscreen();
                }
              }}
              onPlay={() => setMedia((prev) => setMediaPaused(prev, false))}
              onPause={() => setMedia((prev) => setMediaPaused(prev, true))}
              onEnded={() => setMedia((prev) => setMediaPaused(prev, true))}
              onLoadedMetadata={() => {
                const { duration: nextDuration, ratio } = readVideoMetrics(
                  video,
                  props.view.recording,
                );
                setMedia((prev) => updateMediaMetadata(prev, nextDuration, ratio));
              }}
              onLoadedData={() => {
                const { duration: nextDuration, ratio } = readVideoMetrics(
                  video,
                  props.view.recording,
                );
                setMedia((prev) =>
                  markMediaLoaded(prev, video?.currentTime ?? 0, nextDuration, ratio),
                );
                const id = props.view.recording?.id;
                if (restoredRecording === id) return;
                restoredRecording = id;
                restoreRetainedPlayhead(video, props.viewKey, id);
              }}
              onSeeked={syncPlayhead}
              onError={() => setMedia(markMediaFailed)}
              onTimeUpdate={syncPlayhead}
            >
              <track
                kind="captions"
                src={captionsURL()}
                srclang="en"
                label="QA scenario descriptions"
              />
              Your browser cannot play this QA recording.
            </video>
          </Show>
          <RecordingSurfaceOverlays
            view={props.view}
            playhead={playhead()}
            readOnly={props.readOnly}
            videoReady={videoReady()}
            locked={props.locked}
            markingVideo={props.markingVideo}
            commentButtonRef={(el) => {
              commentButton = el;
            }}
            onCancelMarkingOnEscape={cancelMarkingOnEscape}
            onToggleComment={() => {
              if (props.markingVideo) props.onCancelMarking();
              else
                void captureRecordingFrame({
                  video,
                  player,
                  recording: props.view.recording,
                  currentRecordingID: () => props.view.recording?.id,
                  hasDraftBody: props.hasDraftBody,
                  onOpenComposer: props.onOpenComposer,
                  onCapturedFrame: props.onCapturedFrame,
                  onError: props.onError,
                });
            }}
            onSelectPoint={props.onSelectFramePoint}
            onFocusFeedback={props.onFocusFeedback}
          />
        </div>
        <Show when={completedRecording()}>
          {(current) => (
            <ReviewPlayerControls
              time={playhead()}
              duration={duration()}
              paused={paused()}
              ready={duration() > 0 && !videoFailed()}
              fullscreen={fullscreen()}
              scenarios={current().view.scenarios}
              feedback={current().view.feedback}
              recordingID={current().recording.id}
              onPlay={togglePlayback}
              onSeek={seek}
              onFeedback={props.onFocusFeedback}
              onFullscreen={() => void toggleFullscreen()}
            />
          )}
        </Show>
      </div>
      <Show when={videoFailed()}>
        <p role="alert" class="review-error">
          The QA video could not load. Saved frames and feedback remain available.{" "}
          <button
            type="button"
            class="quiet-button"
            onClick={() => {
              setMedia(resetMediaForRecording);
              video?.load();
            }}
          >
            Retry video
          </button>
        </p>
      </Show>
      <Show when={props.showRecordingComposer}>{props.composer}</Show>
      <RecordingScenarioSummary
        view={props.view}
        selectedScenario={props.selectedScenario}
        onSelectScenario={(scenario) => {
          if (scenario.observationKind === "source" || scenario.hasRecordingPosition === false)
            video?.pause();
          props.onSelectedScenario(scenario.id);
          if (
            video &&
            props.view.recording?.state === "complete" &&
            scenario.observationKind !== "source" &&
            scenario.hasRecordingPosition !== false
          )
            seek(scenario.startedMs / 1000, scenario.id);
        }}
      />
    </div>
  );
}
