import { For, Show } from "solid-js";
import type {
  ReviewFeedback,
  VisualReview,
} from "../../../../packages/conversation-domain/src/visual-review";
import { Icon } from "../icon";
import { adjacentScenario, reviewTime, timedScenarios } from "./playback";

export function ReviewPlayerControls(props: {
  time: number;
  duration: number;
  paused: boolean;
  ready: boolean;
  fullscreen: boolean;
  scenarios: VisualReview["scenarios"];
  feedback: ReviewFeedback[];
  recordingID: string;
  onPlay(): void;
  onSeek(seconds: number): void;
  onFeedback(item: ReviewFeedback): void;
  onFullscreen(): void;
}) {
  const progress = () =>
    props.duration > 0 ? Math.min(100, (props.time / props.duration) * 100) : 0;
  const position = (seconds: number) =>
    `${Math.min(99, Math.max(1, (seconds / (props.duration || 1)) * 100))}%`;
  const jump = (direction: -1 | 1) => {
    const chapter = adjacentScenario(props.scenarios, props.time, direction);
    if (chapter) props.onSeek(chapter.startedMs / 1000);
    else if (direction === -1) props.onSeek(0);
  };
  const timeline = () => (
    <div class="review-timeline">
      <div class="review-timeline-track" aria-hidden="true">
        <span style={{ width: `${progress()}%` }} />
        <For each={timedScenarios(props.scenarios)}>
          {(scenario) => <i style={{ left: position(scenario.startedMs / 1000) }} />}
        </For>
      </div>
      <input
        type="range"
        min="0"
        max={props.duration || 1}
        step="0.1"
        value={Math.min(props.time, props.duration)}
        aria-label="QA timeline"
        aria-valuetext={`${reviewTime(props.time, true)} of ${reviewTime(props.duration)}`}
        disabled={!props.ready}
        onInput={(event) => props.onSeek(Number(event.currentTarget.value))}
      />
      <div class="review-timeline-feedback">
        <For each={props.feedback}>
          {(item, index) => {
            const moment = () => {
              const annotation = item.annotation;
              return annotation?.source === "recording" &&
                annotation.recordingId === props.recordingID
                ? { seconds: annotation.timestampMs / 1000 }
                : undefined;
            };
            return (
              <Show when={moment()}>
                {(time) => (
                  <button
                    type="button"
                    class={`review-timeline-marker ${item.kind === "thread" && item.state !== "resolved" ? "is-thread" : ""}`}
                    style={{ left: position(time().seconds) }}
                    aria-label={`QA feedback ${index() + 1} at ${reviewTime(time().seconds, true)}`}
                    title={`${reviewTime(time().seconds, true)} · ${item.messages[0]?.body ?? "Feedback"}`}
                    disabled={!props.ready}
                    onClick={() => props.onFeedback(item)}
                  >
                    <span />
                  </button>
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
  return (
    <fieldset class="review-player-controls">
      <legend class="sr-only">QA playback controls</legend>
      <div class="review-transport">
        <button
          type="button"
          class="bare-icon review-play"
          aria-label={props.paused ? "Play QA recording" : "Pause QA recording"}
          title={props.paused ? "Play" : "Pause"}
          disabled={!props.ready}
          onClick={props.onPlay}
        >
          <Icon name={props.paused ? "play" : "pause"} />
        </button>
        <button
          type="button"
          class="bare-icon"
          aria-label="Previous scenario"
          title="Previous scenario"
          disabled={!props.ready || props.time <= 0}
          onClick={() => jump(-1)}
        >
          <Icon name="skip-back" />
        </button>
        <button
          type="button"
          class="bare-icon"
          aria-label="Next scenario"
          title="Next scenario"
          disabled={!props.ready || !adjacentScenario(props.scenarios, props.time, 1)}
          onClick={() => jump(1)}
        >
          <Icon name="skip-forward" />
        </button>
        {timeline()}
        <span class="review-clock" aria-live="off">
          {reviewTime(props.time)} <span>/ {reviewTime(props.duration)}</span>
        </span>
        <button
          type="button"
          class="bare-icon review-fullscreen"
          aria-label={props.fullscreen ? "Exit full screen" : "Full screen"}
          title={props.fullscreen ? "Exit full screen" : "Full screen"}
          disabled={!props.ready}
          onClick={props.onFullscreen}
        >
          <Icon name="fullscreen" />
        </button>
      </div>
    </fieldset>
  );
}
