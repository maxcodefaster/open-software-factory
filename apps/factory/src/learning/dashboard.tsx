import { For, Show } from "solid-js";
import {
  type LearningView,
  learningBatchAgeMs,
  maxCalibrationGrades,
} from "#conversation-domain/learning";
import "./settings.css";
import { type LearningDecision, LearningEditPreview } from "./edit-preview";
import { learningTargetLabels } from "./flow";
import { LearningFlow } from "./learning-flow";
import { LearningHistory } from "./learning-history";
import { type LearningReviewNow, ReviewNow } from "./review-now";
import { money, plural, sum, WorkChart, waitingDate } from "./work-chart";

export type { LearningReviewNow };
export { WorkChart };

const waitingClock = (since: string) => {
  const due = Date.parse(since) + learningBatchAgeMs;
  const clock = `${waitingDate(new Date(due).toISOString())} UTC`;
  return due > Date.now()
    ? `It starts at six selected cases, or at ${clock}, 24 hours after the oldest settled (${waitingDate(since)} UTC).`
    : `The 24 hour limit passed at ${clock} (oldest settled ${waitingDate(since)} UTC). It starts on the next background pass unless judge calibration or another review holds it.`;
};
const fewCases = 10;
const calibrationNote = (calibration: LearningView["calibration"]) => {
  switch (calibration.state) {
    case "running":
      return "Calibrating: the judge is grading the fixed cases. Work review starts after it passes.";
    case "passed":
      return "Judge calibrated on the fixed cases.";
    case "retrying":
      return `Calibration graded a fixed case wrongly (${calibration.attempts} of ${maxCalibrationGrades} attempts). The next review repeats it before judging work.`;
    case "closed":
      return `Calibration did not pass after ${maxCalibrationGrades} attempts. No paid review runs until the Planning model or judge instructions change.`;
    case "unconfirmed":
      return "The last calibration call has no confirmed outcome. It will not repeat automatically.";
    default:
      return "The judge has not been calibrated yet. The first review starts with the fixed calibration cases.";
  }
};

export function LearningDashboard(props: {
  view: LearningView;
  busy?: boolean;
  refreshBusy?: boolean;
  onRefresh?: (() => void) | undefined;
  onToggle?: (() => void) | undefined;
  onAutomaticToggle?: (() => void) | undefined;
  onDecide?: LearningDecision | undefined;
  onRollback?: ((id: string, revisionId: string) => void) | undefined;
  onReviewNow?: LearningReviewNow | undefined;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
}) {
  let dashboard: HTMLElement | undefined;
  const total = (key: Parameters<typeof sum>[1]) => sum(props.view.days, key);
  const knownCost = () =>
    props.view.days.reduce((total, day) => total + BigInt(day.knownNanoUSD), 0n).toString();
  const proposed = () => props.view.proposals.filter((proposal) => proposal.state === "proposed");
  function inspectRecord(id: string) {
    const target = dashboard?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    for (let element: HTMLElement | null = target; element; element = element.parentElement)
      if (element instanceof HTMLDetailsElement) element.open = true;
    target.scrollIntoView({ block: "center", behavior: "instant" });
    const focus = target instanceof HTMLDetailsElement ? target.querySelector("summary") : target;
    focus?.focus({ preventScroll: true });
  }
  function inspectSource(reviewId: string, reference: string, kind: "case" | "evidence") {
    const review = props.view.reviews.find((item) => item.id === reviewId);
    if (!review) return;
    let targetId: string | undefined;
    for (const [caseIndex, item] of review.cases.entries()) {
      if (kind === "case" && item.id === reference) targetId = `work-case-${reviewId}-${caseIndex}`;
      const evidenceIndex = item.evidence.findIndex((source) => source.id === reference);
      if (kind === "evidence" && evidenceIndex >= 0)
        targetId = `work-evidence-${reviewId}-${caseIndex}-${evidenceIndex}`;
    }
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    for (let element: HTMLElement | null = target; element; element = element.parentElement)
      if (element instanceof HTMLDetailsElement) element.open = true;
    target.scrollIntoView({ block: "center", behavior: "instant" });
    target.focus({ preventScroll: true });
  }
  return (
    <section class="learning-dashboard" aria-label="Factory monitoring" ref={dashboard}>
      <Show when={props.view.projectId}>
        <details class="work-history">
          <summary>Learning history</summary>
          <LearningFlow view={props.view} onInspect={inspectRecord} />
        </details>
      </Show>
      <div class="work-overview-heading work-section-heading">
        <div>
          <h3>Work, quality & cost</h3>
          <p>
            {props.view.scope === "personal"
              ? "Private learning from your work. Nothing is promoted to the Project without your decision."
              : "Last 28 days of settled work and retained review evidence."}
          </p>
        </div>
        <Show when={props.onRefresh}>
          {(refresh) => (
            <button
              type="button"
              class="workspace-action work-refresh"
              disabled={props.refreshBusy ?? props.busy}
              onClick={() => refresh()()}
            >
              Refresh observations
            </button>
          )}
        </Show>
      </div>
      <dl class="work-summary">
        <div>
          <dt>Settled operations</dt>
          <dd>{total("operations")}</dd>
        </div>
        <div>
          <dt>Evidence reviewed</dt>
          <dd>
            {total("reviewed")}
            <small> / {total("selected")} selected</small>
          </dd>
        </div>
        <div>
          <dt>Avoidable rework</dt>
          <dd>
            {total("reworkKnown") ? `${total("avoidable")} / ${total("reworkKnown")}` : "Unknown"}
            <small>
              {total("reworkKnown")
                ? total("reworkKnown") < fewCases
                  ? " known cases, too few for a rate"
                  : " known cases"
                : " until reviewed"}
            </small>
          </dd>
        </div>
        <div>
          <dt>Known model cost</dt>
          <dd>
            {money(knownCost())}
            <small>
              {props.view.days.some((day) => day.incomplete) ? " + unknown" : " estimated"}
            </small>
          </dd>
        </div>
      </dl>
      <Show when={total("reviewed") > 0 && total("reviewed") < fewCases}>
        <p class="work-note" data-few-cases>
          Only {plural(total("reviewed"), "case")} reviewed so far. Rates from so few cases are
          anecdotes, not a trend.
        </p>
      </Show>
      <Show when={total("operations") === 0 && total("observed") === 0}>
        <p class="work-note" data-no-work>
          No work settled in the last 28 days. The charts fill in as work settles.
        </p>
      </Show>
      <Show when={props.view.detailScope === "own" && props.view.scope !== "personal"}>
        <p class="work-note">
          Costs and operation counts are yours. Review coverage below concerns authorized shared
          work.
        </p>
      </Show>
      <Show when={total("operations") || total("observed") || total("reviewed")}>
        <WorkChart days={props.view.days} />
      </Show>
      <Show when={props.view.projectId}>
        <section class="work-learning" aria-labelledby="work-learning-title">
          <div class="work-section-heading">
            <div>
              <h3 id="work-learning-title">Learning from work</h3>
            </div>
            <Show when={props.view.canManage}>
              <button
                type="button"
                class="secondary-button"
                disabled={
                  props.busy || (!props.view.parentEnabled && props.view.scope === "personal")
                }
                onClick={props.onToggle}
              >
                {props.view.enabled ? "Pause learning" : "Resume learning"}
              </button>
            </Show>
          </div>
          <div class="work-learning-state">
            <span class="work-state-dot" data-enabled={props.view.enabled ? "true" : "false"} />
            <strong>{props.view.enabled ? "Automatic review on" : "Learning paused"}</strong>
            <span>
              {total("observed")} observed · {total("selected")} selected · {total("reviewed")}{" "}
              reviewed
            </span>
          </div>
          <Show when={props.view.waiting}>
            <p class="work-note" data-waiting={props.view.waiting}>
              {props.view.waiting} selected {props.view.waiting === 1 ? "case is" : "cases are"}{" "}
              waiting for a review.{" "}
              {!props.view.enabled
                ? "Nothing is reviewed while learning is paused."
                : props.view.waitingSince
                  ? waitingClock(props.view.waitingSince)
                  : "It starts at six selected cases, or 24 hours after the oldest settled."}
            </p>
            <Show when={props.view.canManage && props.view.enabled}>
              <ReviewNow view={props.view} busy={props.busy} onReviewNow={props.onReviewNow} />
            </Show>
          </Show>
          <Show when={!props.view.waiting && props.view.reviewRunning}>
            <p class="work-note" role="status" data-review-state>
              A review of this work is running.
            </p>
          </Show>
          <details class="work-method">
            <summary>Review workflow & calibration</summary>
            <p class="work-note">
              One batched review after six selected cases or 24 hours. Failed work with retained
              evidence and a stable one-in-five sample of completed work.
            </p>
            <Show when={["passed", "none"].includes(props.view.calibration.state)}>
              <p class="work-note" data-calibration={props.view.calibration.state}>
                {calibrationNote(props.view.calibration)}
              </p>
            </Show>
            <p class="work-note">
              Analysis grants no write authority. Existing approvals and Verification stay in force.
            </p>
          </details>
          <Show when={!["passed", "none"].includes(props.view.calibration.state)}>
            <p class="work-note" data-calibration={props.view.calibration.state}>
              {calibrationNote(props.view.calibration)}
            </p>
          </Show>
          <details class="work-automatic">
            <summary>
              Automatic Skill updates · {props.view.automaticSkills ? "Allowed" : "Off"}
            </summary>
            <p class="work-note">
              Allow future small edits to enabled, plain Planning Skills owned by this{" "}
              {props.view.scope === "personal" ? "personal context" : "Project"}. Each edit needs
              two observed method failures and a separate healthy task with complete retained
              artifacts. Two isolated text replays and a blinded, calibrated judge must show a fix
              with no control regression before adoption. Inconclusive results remain proposals.
            </p>
            <p class="work-note">
              This does not replay tools or benchmark Build. Factory guidance, required rules,
              packages, Wiki, Inputs, tests and CI are not automatically changed. Private work
              cannot change shared guidance. Later sampled failures can trigger one compared,
              version-protected recovery. Newer human edits always win.
            </p>
            <Show when={props.view.canManage}>
              <button
                type="button"
                class="secondary-button"
                disabled={props.busy || (!props.view.enabled && !props.view.automaticSkills)}
                onClick={props.onAutomaticToggle}
              >
                {props.view.automaticSkills
                  ? "Stop automatic Skill updates"
                  : "Allow compared Skill updates"}
              </button>
            </Show>
          </details>
          <Show when={!props.view.parentEnabled && props.view.scope === "personal"}>
            <p class="work-note">
              Project learning is paused. Your personal setting cannot override it.
            </p>
          </Show>
          <Show
            when={proposed().length}
            fallback={
              <div class="work-empty">
                <h4>
                  {props.view.applications.length
                    ? "No pending improvement"
                    : total("observed")
                      ? total("reviewed")
                        ? "No supported improvement to act on yet"
                        : "Nothing reviewed yet"
                      : "Learning starts with completed work"}
                </h4>
                <p>
                  Opening this page never starts an AI call. New work is collected in the
                  background; weak evidence does not become another rule.
                </p>
              </div>
            }
          >
            <ol class="work-proposals">
              <For each={proposed()}>
                {(proposal) => (
                  <li id={`work-proposal-${proposal.id}`} tabindex="-1" class="work-proposal">
                    <div class="work-proposal-heading">
                      <h4>{proposal.content.title}</h4>
                      <span>{learningTargetLabels[proposal.content.target]}</span>
                    </div>
                    <p>{proposal.content.change}</p>
                    <LearningEditPreview
                      proposal={proposal}
                      busy={props.busy ?? false}
                      canRequest={props.view.canManage}
                      onDecide={props.onDecide}
                    />
                    <details>
                      <summary>Why this change, and how to check it</summary>
                      <dl class="work-proposal-evidence">
                        <dt>Expected effect, not measured yet</dt>
                        <dd>{proposal.content.expectedEffect}</dd>
                        <dt>Validation</dt>
                        <dd>{proposal.content.validation}</dd>
                        <dt>Source</dt>
                        <dd>
                          {proposal.content.caseIds.length}{" "}
                          {proposal.content.caseIds.length === 1 ? "case" : "cases"} ·{" "}
                          {proposal.content.evidenceIds.length} evidence references
                          <ul class="work-source-references">
                            <For each={proposal.content.caseIds}>
                              {(id) => (
                                <li>
                                  <button
                                    type="button"
                                    class="text-button"
                                    onClick={() => inspectSource(proposal.reviewId, id, "case")}
                                  >
                                    Case <code>{id}</code>
                                  </button>
                                </li>
                              )}
                            </For>
                            <For each={proposal.content.evidenceIds}>
                              {(id) => (
                                <li>
                                  <button
                                    type="button"
                                    class="text-button"
                                    onClick={() => inspectSource(proposal.reviewId, id, "evidence")}
                                  >
                                    Evidence <code>{id}</code>
                                  </button>
                                </li>
                              )}
                            </For>
                          </ul>
                        </dd>
                      </dl>
                      <Show when={proposal.private}>
                        <p class="work-note">
                          Creating a Ticket shares the title, proposed change, expected effect and
                          validation shown here. Your source packet and private chat are not shared.
                        </p>
                      </Show>
                    </details>
                    <Show when={props.view.canManage}>
                      <div class="work-proposal-actions">
                        <Show when={!proposal.content.edit}>
                          <button
                            class="secondary-button"
                            type="button"
                            disabled={props.busy}
                            onClick={() =>
                              props.onDecide?.(proposal.id, "create-ticket", proposal.private)
                            }
                          >
                            {proposal.private
                              ? "Share proposal as Ticket"
                              : "Create improvement Ticket"}
                          </button>
                        </Show>
                        <button
                          class="text-button"
                          type="button"
                          disabled={props.busy}
                          onClick={() => props.onDecide?.(proposal.id, "dismiss", false)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <LearningHistory
            view={props.view}
            busy={props.busy}
            onRollback={props.onRollback}
            onOpenTicket={props.onOpenTicket}
          />
        </section>
      </Show>
    </section>
  );
}
