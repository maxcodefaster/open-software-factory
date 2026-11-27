import { For, Show } from "solid-js";
import type { ReviewFeedback, VisualReview } from "#conversation-domain/visual-review";
import { Icon } from "../icon";
import { scenarioStatusLabel } from "./panel-state";

export function RecordingSurfaceOverlays(props: {
  view: VisualReview;
  playhead: number;
  readOnly: boolean;
  videoReady: boolean;
  locked: boolean;
  markingVideo: boolean;
  commentButtonRef: (el: HTMLButtonElement) => void;
  onCancelMarkingOnEscape(event: KeyboardEvent): void;
  onToggleComment(): void;
  onSelectPoint(x: number, y: number, rect: DOMRect): void;
  onFocusFeedback(item: ReviewFeedback): void;
}) {
  return (
    <>
      <Show when={!props.markingVideo && props.view.recording?.state === "complete"}>
        <For each={props.view.feedback} keyed={(item) => item.id}>
          {(item, index) => {
            const point = () => {
              const annotation = item().annotation;
              return annotation?.source === "recording" &&
                annotation.recordingId === props.view.recording?.id &&
                Math.abs(annotation.timestampMs / 1000 - props.playhead) <= 0.35
                ? annotation.region
                : undefined;
            };
            return (
              <Show when={point()}>
                {(region) => (
                  <button
                    type="button"
                    class="review-video-pin"
                    aria-label={`Open QA feedback ${index() + 1}`}
                    style={{ left: `${region().x * 100}%`, top: `${region().y * 100}%` }}
                    onClick={() => props.onFocusFeedback(item())}
                  >
                    {index() + 1}
                  </button>
                )}
              </Show>
            );
          }}
        </For>
      </Show>
      <Show when={props.view.recording?.state === "complete" && !props.readOnly}>
        <button
          ref={props.commentButtonRef}
          type="button"
          class="review-comment-fab quiet-button"
          disabled={!props.videoReady || props.locked}
          aria-pressed={props.markingVideo ? "true" : "false"}
          onKeyDown={props.onCancelMarkingOnEscape}
          onClick={props.onToggleComment}
        >
          <Icon name="comment" />
          {props.markingVideo ? "Cancel selection" : "Comment"}
        </button>
      </Show>
      <Show when={props.markingVideo}>
        <button
          type="button"
          class="review-video-selection"
          aria-label="Choose a point on the paused QA frame"
          onKeyDown={props.onCancelMarkingOnEscape}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x =
              event.detail === 0
                ? 0.5
                : Math.max(0, Math.min(0.999, (event.clientX - rect.x) / rect.width));
            const y =
              event.detail === 0
                ? 0.5
                : Math.max(0, Math.min(0.999, (event.clientY - rect.y) / rect.height));
            props.onSelectPoint(x, y, rect);
          }}
        >
          <span>Click a point to add feedback. Enter selects the centre.</span>
        </button>
      </Show>
    </>
  );
}

export function RecordingScenarioSummary(props: {
  view: VisualReview;
  selectedScenario: string;
  onSelectScenario(scenario: VisualReview["scenarios"][number]): void;
}) {
  return (
    <>
      <Show when={props.view.scenarios.length}>
        <div class="review-scenario-summary">
          <fieldset class="review-scenarios">
            <legend class="sr-only">QA scenarios</legend>
            <For each={props.view.scenarios} keyed={(scenario) => scenario.id}>
              {(scenario) => (
                <button
                  type="button"
                  aria-pressed={props.selectedScenario === scenario().id ? "true" : "false"}
                  onClick={() => props.onSelectScenario(scenario())}
                >
                  <span class={`review-scenario-status is-${scenario().status ?? "unfinished"}`}>
                    {scenarioStatusLabel(scenario().status)}
                  </span>
                  <span>{scenario().title}</span>
                  <Show when={scenario().observationKind === "source"}>
                    <small>Source check</small>
                  </Show>
                  <Show
                    when={
                      scenario().observationKind !== "source" &&
                      props.view.recording?.state === "complete" &&
                      scenario().hasRecordingPosition === false
                    }
                  >
                    <small>Timing unavailable</small>
                  </Show>
                </button>
              )}
            </For>
          </fieldset>
          <For
            each={props.view.scenarios.filter((item) => item.id === props.selectedScenario)}
            keyed={(scenario) => scenario.id}
          >
            {(scenario) => (
              <dl class="review-scenario-outcome" aria-label={`${scenario().title} result`}>
                <Show when={scenario().expected}>
                  <div>
                    <dt>Expected</dt>
                    <dd>{scenario().expected}</dd>
                  </div>
                </Show>
                <Show when={scenario().observed}>
                  <div>
                    <dt>Observed</dt>
                    <dd>{scenario().observed}</dd>
                  </div>
                </Show>
              </dl>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.view.recording?.state === "complete"}>
        <p class="review-recording-meta">
          <Show when={props.view.recordingCurrent === false}>Earlier QA run. </Show>
          Reviewed version <code>{props.view.recording?.commitSha.slice(0, 8)}</code>.
          <Show when={props.view.recording?.reason}> {props.view.recording?.reason}</Show>
        </p>
      </Show>
    </>
  );
}
