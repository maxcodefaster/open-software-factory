import { createSignal, Show } from "solid-js";
import {
  type LearningView,
  learningBatchSize,
  maxCalibrationGrades,
} from "#conversation-domain/learning";
import { plural, waitingDate } from "./work-chart";

export type LearningReviewNow = (request: { developerOnly: boolean; cases: number }) => void;

export function ReviewNow(props: {
  view: LearningView;
  busy?: boolean | undefined;
  onReviewNow?: LearningReviewNow | undefined;
}) {
  const [confirming, setConfirming] = createSignal(false);
  const cases = () => Math.min(props.view.waiting, learningBatchSize);
  const calibration = () => props.view.calibration.state;
  const calls = () =>
    calibration() === "passed"
      ? "1 review call"
      : calibration() === "running"
        ? "1 review call after the running calibration passes"
        : `1 calibration call first (up to ${maxCalibrationGrades} if the judge grades a fixed case wrongly), then 1 review call`;
  const blocked = () => calibration() === "closed" || calibration() === "unconfirmed";
  return (
    <Show
      when={!props.view.reviewRunning && !props.view.reviewRequestedAt}
      fallback={
        <p class="work-note" role="status" data-review-state>
          {props.view.reviewRunning
            ? "A review of this work is running."
            : `Review requested ${waitingDate(props.view.reviewRequestedAt ?? "")} UTC. It starts within a minute, after the judge is calibrated. A request expires after an hour.`}
        </p>
      }
    >
      <Show
        when={confirming()}
        fallback={
          <div class="control-actions work-review-now-actions">
            <button
              type="button"
              class="quiet-button"
              data-review-now
              disabled={props.busy || blocked()}
              onClick={() => setConfirming(true)}
            >
              Review now
            </button>
          </div>
        }
      >
        <fieldset class="work-review-now" aria-label="Confirm review now">
          <p class="work-note" data-review-now-confirmation>
            Review {plural(cases(), "selected case")} now? This makes paid Planning-model calls:{" "}
            {calls()}. It uses the configured Planning model after checking your current authority
            and the pause setting, reads only the retained evidence of{" "}
            {cases() === 1 ? "this case" : "these cases"}, and never repeats a call whose outcome is
            lost.
          </p>
          <div class="control-actions">
            <button
              type="button"
              class="quiet-button"
              disabled={props.busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              class="primary-button"
              data-review-now-confirm
              disabled={props.busy}
              onClick={() => {
                setConfirming(false);
                props.onReviewNow?.({
                  developerOnly: props.view.waitingDeveloperOnly,
                  cases: cases(),
                });
              }}
            >
              Start paid review
            </button>
          </div>
        </fieldset>
      </Show>
    </Show>
  );
}
