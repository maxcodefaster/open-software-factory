import { createEffect, createSignal, For, Show } from "solid-js";
import type {
  LearningDay,
  LearningView,
} from "../../../../packages/conversation-domain/src/learning";
import "./settings.css";
import { LearningEditPreview, type LearningDecision } from "./edit-preview";
import { LearningFlow } from "./learning-flow";

const money = (nano: string | number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number(nano) < 1e9 ? 4 : 2,
  }).format(Number(nano) / 1e9);
const date = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
type Metric = "outcomes" | "quality" | "cost" | "elapsed";
const labels: Record<Metric, string> = {
  outcomes: "Work",
  quality: "Reviewed quality",
  cost: "Model cost",
  elapsed: "Elapsed time",
};
const sum = (
  days: LearningDay[],
  key:
    | "operations"
    | "reviewed"
    | "supported"
    | "problems"
    | "avoidable"
    | "reworkKnown"
    | "selected"
    | "observed",
) => days.reduce((total, day) => total + day[key], 0);
const duration = (seconds: number) =>
  seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} sec`;

export function WorkChart(props: { days: LearningDay[] }) {
  let plot: HTMLDivElement | undefined;
  const [chartWidth, setChartWidth] = createSignal(760);
  createEffect(
    () => props.days,
    () => {
      let disposed = false;
      let observer: ResizeObserver | undefined;
      // Refs are assigned by rendering, after the component's first effect
      // source is evaluated. Observe the mounted plot, not an undefined ref.
      queueMicrotask(() => {
        if (disposed || !plot) return;
        observer = new ResizeObserver(([entry]) => {
          if (entry) setChartWidth(Math.max(300, Math.round(entry.contentRect.width)));
        });
        observer.observe(plot);
      });
      return () => {
        disposed = true;
        observer?.disconnect();
      };
    },
  );
  const plotWidth = () => chartWidth() - 68;
  const [metric, setMetric] = createSignal<Metric>("outcomes");
  const [selected, setSelected] = createSignal<number>();
  const values = (day: LearningDay) => {
    switch (metric()) {
      case "cost":
        return [Number(day.knownNanoUSD) / 1e9];
      case "elapsed":
        return [day.elapsedSeconds ?? 0];
      case "quality":
        return [day.supported, day.problems, day.reviewed - day.supported - day.problems];
      default:
        return [day.completed, day.failed, day.unknown];
    }
  };
  const max = () =>
    Math.max(
      metric() === "cost" ? 0.01 : 1,
      ...props.days.map((day) => values(day).reduce((a, b) => a + b, 0)),
    );
  const axis = (value: number) =>
    metric() === "cost"
      ? money(value * 1e9)
      : metric() === "elapsed"
        ? duration(value)
        : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
  const description = (day: LearningDay) =>
    `${date(day.date)}. ${
      metric() === "cost"
        ? `${money(day.knownNanoUSD)}${day.incomplete ? " plus unknown costs" : " known estimate"}`
        : metric() === "elapsed"
          ? day.elapsedSeconds === null
            ? "No settled operations"
            : `Median ${duration(day.elapsedSeconds)}, including queue and execution`
          : metric() === "quality"
            ? `${day.supported} supported, ${day.problems} problems, ${day.reviewed - day.supported - day.problems} unknown, of ${day.reviewed} reviewed cases`
            : `${day.completed} completed, ${day.failed} failed or interrupted, ${day.unknown} unknown, of ${day.operations} settled operations`
    }`;
  const selectedDescription = () => {
    const index = selected();
    const day = index === undefined ? undefined : props.days[index];
    return day ? description(day) : undefined;
  };
  const legend = () =>
    metric() === "quality"
      ? ["Supported", "Problem", "Insufficient evidence"]
      : metric() === "outcomes"
        ? ["Completed", "Failed / interrupted", "Unknown"]
        : metric() === "cost"
          ? ["Known estimate"]
          : ["Median operation elapsed"];
  return (
    <section class="work-chart" aria-label="Work trends">
      <div class="work-chart-toolbar">
        <fieldset class="work-chart-metrics" aria-label="Chart metric">
          <For each={Object.entries(labels) as [Metric, string][]}>
            {([key, label]) => (
              <button
                type="button"
                aria-pressed={metric() === key ? "true" : "false"}
                onClick={() => {
                  setMetric(key);
                  setSelected(undefined);
                }}
              >
                {label}
              </button>
            )}
          </For>
        </fieldset>
        <span class="work-period">28 days · UTC</span>
      </div>
      <div class="work-chart-plot" ref={plot}>
        {/* biome-ignore lint/a11y/useSemanticElements: SVG data marks need an accessible group; an HTML fieldset cannot replace the plot. */}
        <svg
          viewBox={`0 0 ${chartWidth()} 230`}
          role="group"
          aria-label={`${labels[metric()]} by day`}
        >
          <For each={[0, 0.5, 1]}>
            {(fraction) => (
              <g class="work-chart-axis">
                <line
                  x1="56"
                  x2={chartWidth() - 12}
                  y1={190 - fraction * 160}
                  y2={190 - fraction * 160}
                />
                <text x="46" y={194 - fraction * 160} text-anchor="end">
                  {axis(max() * fraction)}
                </text>
              </g>
            )}
          </For>
          <For each={props.days}>
            {(day, index) => {
              const x = () => 60 + (index() * plotWidth()) / Math.max(1, props.days.length);
              const width = () =>
                plotWidth() / Math.max(1, props.days.length) - (chartWidth() < 500 ? 2 : 5);
              return (
                // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: Focusable data images expose the same reading on focus as on hover; they do not perform a button action.
                <g
                  class="work-chart-day"
                  role="img"
                  tabindex="0"
                  aria-label={description(day)}
                  onPointerEnter={() => setSelected(index())}
                  onFocus={() => setSelected(index())}
                  onBlur={() => setSelected(undefined)}
                  onPointerLeave={() => setSelected(undefined)}
                >
                  <rect
                    class="work-chart-hit"
                    x={x() - 2}
                    y="22"
                    width={width() + 4}
                    height="174"
                    rx="2"
                  />
                  <For each={values(day)}>
                    {(value, part) => (
                      <rect
                        class={`work-chart-bar work-chart-part-${part()}`}
                        data-metric={metric()}
                        x={x()}
                        width={Math.max(1, width())}
                        y={
                          190 -
                          (values(day)
                            .slice(0, part() + 1)
                            .reduce((a, b) => a + b, 0) /
                            max()) *
                            160
                        }
                        height={(value / max()) * 160}
                        rx="1"
                      >
                        <title>{description(day)}</title>
                      </rect>
                    )}
                  </For>
                  <Show when={metric() === "cost" && day.incomplete}>
                    <line class="work-chart-gap" x1={x()} x2={x() + width()} y1="24" y2="24" />
                  </Show>
                </g>
              );
            }}
          </For>
          <For each={[0, Math.floor((props.days.length - 1) / 2), props.days.length - 1]}>
            {(index) => (
              <text
                class="work-chart-date"
                x={
                  index === props.days.length - 1
                    ? chartWidth() - 12
                    : 62 + (index * plotWidth()) / Math.max(1, props.days.length)
                }
                y="216"
                text-anchor={
                  index === props.days.length - 1 ? "end" : index === 0 ? "start" : "middle"
                }
              >
                {props.days[index] ? date(props.days[index].date) : ""}
              </text>
            )}
          </For>
        </svg>
      </div>
      <div class="work-chart-legend">
        <For each={legend()}>
          {(label, index) => (
            <span>
              <i class={`work-chart-key work-chart-part-${index()}`} />
              {label}
            </span>
          )}
        </For>
        <Show when={metric() === "cost" && props.days.some((day) => day.incomplete)}>
          <span>
            <i class="work-chart-key-incomplete" />
            Incomplete cost
          </span>
        </Show>
      </div>
      <p class="work-chart-reading" aria-live="polite">
        {selectedDescription() ??
          (metric() === "quality"
            ? "Judged cases only. Missing evidence stays unknown; this is not the quality of all work."
            : metric() === "elapsed"
              ? "Queue to settlement, not active model time. Different activities are not a matched benchmark."
              : metric() === "cost"
                ? "Saved model-price estimates, including work review. Missing prices are not zero."
                : "Settled model operations. Completed does not mean independently verified.")}
      </p>
      <details class="work-chart-data">
        <summary>View daily data</summary>
        <div class="work-data-scroll">
          <table>
            <caption>Last 28 days, UTC. Empty quality cells mean no reviewed evidence.</caption>
            <thead>
              <tr>
                <th>Date</th>
                <th>Operations</th>
                <th>Reviewed</th>
                <th>Supported / problems</th>
                <th>Avoidable rework</th>
                <th>Known cost</th>
                <th>Elapsed median</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.days}>
                {(day) => (
                  <tr>
                    <th scope="row">{date(day.date)}</th>
                    <td>{day.operations}</td>
                    <td>{day.reviewed}</td>
                    <td>{day.reviewed ? `${day.supported} / ${day.problems}` : "Unknown"}</td>
                    <td>
                      {day.reworkKnown ? `${day.avoidable} / ${day.reworkKnown} known` : "Unknown"}
                    </td>
                    <td>
                      {money(day.knownNanoUSD)}
                      {day.incomplete ? " + unknown" : ""}
                    </td>
                    <td>
                      {day.elapsedSeconds === null
                        ? "No observation"
                        : duration(day.elapsedSeconds)}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function LearningDashboard(props: {
  view: LearningView;
  busy?: boolean;
  onToggle?: (() => void) | undefined;
  onAutomaticToggle?: (() => void) | undefined;
  onDecide?: LearningDecision | undefined;
  onRollback?: ((id: string, revisionId: string) => void) | undefined;
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
        <LearningFlow view={props.view} onInspect={inspectRecord} />
      </Show>
      <div class="work-overview-heading">
        <div>
          <h3>Work, quality & cost</h3>
          <p>
            {props.view.scope === "personal"
              ? "Private learning from your work. Nothing is promoted to the Project without your decision."
              : "See where work settles, where evidence is missing, and what is worth improving."}
          </p>
        </div>
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
            <small>{total("reworkKnown") ? " known cases" : " until reviewed"}</small>
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
      <Show when={props.view.detailScope === "own" && props.view.scope !== "personal"}>
        <p class="work-note">
          Costs and operation counts are yours. Review coverage below concerns authorized shared
          work.
        </p>
      </Show>
      <WorkChart days={props.view.days} />
      <Show when={props.view.projectId}>
        <section class="work-learning" aria-labelledby="work-learning-title">
          <div class="work-section-heading">
            <div>
              <h3 id="work-learning-title">Learning from work</h3>
              <p>
                One batched review after six selected cases or 24 hours. Failed work with retained
                evidence and a stable one-in-five sample of completed work.
              </p>
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
          <p class="work-note">
            The judge must pass fixed calibration cases first. Analysis grants no write authority.
            Existing approvals and Verification stay in force.
          </p>
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
                      ? "No supported improvement to act on yet"
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
                      <span>{proposal.content.target}</span>
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
          <Show when={props.view.applications.length}>
            <section class="work-applied" aria-label="Applied improvements">
              <h4>Applied changes</h4>
              <p class="work-note">
                Publication is recorded separately from impact. No measured improvement is claimed
                here.
              </p>
              <ol class="work-proposals">
                <For each={props.view.applications}>
                  {(application) => (
                    <li
                      tabindex="-1"
                      id={`work-application-${application.id}`}
                      class="work-application"
                    >
                      <div class="work-proposal-heading">
                        <h4>{application.title}</h4>
                        <span>{application.state === "reverted" ? "Reverted" : "Applied"}</span>
                      </div>
                      <p class="work-note">
                        {application.targetScope === "system"
                          ? "Factory"
                          : application.targetScope === "personal"
                            ? "Personal"
                            : application.targetScope === "project"
                              ? "Project"
                              : "Exact"}{" "}
                        {application.target.kind} · {application.targetLabel ?? "Resource"} ·
                        version {application.appliedVersion} ·{" "}
                        {new Date(application.createdAt).toLocaleString()}
                      </p>
                      <code>{application.target.id}</code>
                      <p class="work-note">
                        {application.automatic
                          ? "Adopted under saved permission after a matched text replay."
                          : "Applied by an explicit human decision."}
                        {application.automaticRecovery
                          ? " Reverted after a matched recovery comparison."
                          : ""}
                      </p>
                      <p class="work-note">
                        Later use · {application.subsequent.sampled} sampled cases ·{" "}
                        {application.subsequent.reviewed} reviewed ·{" "}
                        {application.subsequent.problems} with problems. These observations are not
                        causal proof of improvement.
                      </p>
                      <Show when={application.subsequent.cases.length}>
                        <details class="work-later-uses">
                          <summary>
                            Inspect latest sampled uses · {application.subsequent.cases.length} of{" "}
                            {application.subsequent.sampled}
                          </summary>
                          <p class="work-note">
                            These cases record exact revision{" "}
                            <code>{application.appliedRevisionId}</code>.
                          </p>
                          <For each={application.subsequent.cases}>
                            {(use) => (
                              <details class="work-evidence-case">
                                <summary>
                                  {use.source.activity} ·{" "}
                                  {use.verdict?.fulfillment ?? "Not reviewed"} ·{" "}
                                  <code>{use.source.id}</code>
                                </summary>
                                <p>
                                  {use.verdict?.explanation ?? "No settled review verdict yet."}
                                </p>
                                <Show when={use.reviewId}>
                                  <p class="work-note">
                                    Review <code>{use.reviewId}</code>
                                  </p>
                                </Show>
                                <For each={use.source.evidence}>
                                  {(source) => (
                                    <details>
                                      <summary>
                                        {source.kind} · {source.id}
                                        {source.truncated ? " · excerpt" : ""}
                                      </summary>
                                      <pre>{source.body}</pre>
                                    </details>
                                  )}
                                </For>
                              </details>
                            )}
                          </For>
                        </details>
                      </Show>
                      <details>
                        <summary>Accepted edit & revision</summary>
                        <code>{application.appliedRevisionId}</code>
                        <div class="work-edit-passages">
                          <section aria-label="Previous passage">
                            <h5>Before</h5>
                            <pre>{application.edit.before}</pre>
                          </section>
                          <section aria-label="Accepted passage">
                            <h5>After</h5>
                            <pre>{application.edit.after}</pre>
                          </section>
                        </div>
                      </details>
                      <Show when={application.state === "applied" && application.canRevert}>
                        <Show when={application.target.kind === "knowledge"}>
                          <p class="work-note">
                            Check the previous text against current sources before restoring
                            Knowledge. Do not restore a disproven fact.
                          </p>
                        </Show>
                        <button
                          type="button"
                          class="text-button"
                          disabled={props.busy}
                          onClick={() =>
                            props.onRollback?.(application.id, application.appliedRevisionId)
                          }
                        >
                          Undo this edit
                        </button>
                        <small>
                          Creates another revision. Newer human writing or choices block Undo.
                        </small>
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            </section>
          </Show>
          <Show when={props.view.comparisons.length}>
            <details class="work-comparisons">
              <summary>Compared changes · {props.view.comparisons.length}</summary>
              <p class="work-note">
                Matched, tool-free text replays under one fixed model and rubric. This checks the
                observed instruction problem, not end-to-end Factory quality or live tool behavior.
              </p>
              <For each={props.view.comparisons}>
                {(comparison) => (
                  <details class="work-review" id={`work-comparison-${comparison.id}`}>
                    <summary>
                      {comparison.title} ·{" "}
                      {comparison.phase === "recover" ? "Recovery" : "Adoption"} ·{" "}
                      {comparison.result?.decision ?? comparison.state}
                    </summary>
                    <p class="work-note">
                      {comparison.modelId} · {comparison.rubric} ·{" "}
                      {new Date(comparison.createdAt).toLocaleString()}
                    </p>
                    <Show when={comparison.reason}>
                      <p>{comparison.reason}</p>
                    </Show>
                    <details class="work-edit-preview">
                      <summary>Compared instruction & exact revision</summary>
                      <p class="work-note">
                        {props.view.scope === "personal" ? "Personal" : "Project"} Skill{" "}
                        <code>{comparison.baselineTarget.id}</code> · baseline version{" "}
                        {comparison.baselineTarget.version}
                      </p>
                      <code>{comparison.baselineTarget.revisionId}</code>
                      <div class="work-edit-passages">
                        <section>
                          <h5>Baseline instruction</h5>
                          <pre>{comparison.before}</pre>
                        </section>
                        <section>
                          <h5>Candidate instruction</h5>
                          <pre>{comparison.after}</pre>
                        </section>
                      </div>
                    </details>
                    <For each={comparison.evidence}>
                      {(item, index) => (
                        <details class="work-evidence-case">
                          <summary>
                            Task {index() + 1} · <code>{item.id}</code>
                          </summary>
                          <For
                            each={item.evidence.filter(
                              (source) => source.kind === "task" || source.kind === "artifact",
                            )}
                          >
                            {(source) => (
                              <details>
                                <summary>
                                  {source.kind} · {source.id}
                                </summary>
                                <pre>{source.body}</pre>
                              </details>
                            )}
                          </For>
                          <For each={comparison.responses}>
                            {(arm, armIndex) => {
                              const verdict = () =>
                                comparison.result?.cases.find(
                                  (grade) => grade.caseId === `replay:${armIndex()}:${index()}`,
                                );
                              return (
                                <section>
                                  <h5>
                                    {(armIndex() === 0) === comparison.candidateFirst
                                      ? "Candidate"
                                      : "Baseline"}{" "}
                                    response
                                  </h5>
                                  <pre>
                                    {arm.answers.find((answer) => answer.caseId === item.id)?.body}
                                  </pre>
                                  <p>
                                    {verdict()?.fulfillment ?? "Not judged"} ·{" "}
                                    {verdict()?.explanation}
                                  </p>
                                </section>
                              );
                            }}
                          </For>
                        </details>
                      )}
                    </For>
                  </details>
                )}
              </For>
            </details>
          </Show>
          <Show when={props.view.proposals.some((proposal) => proposal.state === "ticket-created")}>
            <ul class="work-created-tickets">
              <For each={props.view.proposals.filter((proposal) => proposal.ticketId)}>
                {(proposal) => (
                  <li>
                    <button
                      type="button"
                      class="text-button"
                      onClick={() => {
                        const projectID = props.view.projectId;
                        if (proposal.ticketId && projectID)
                          props.onOpenTicket?.(proposal.ticketId, projectID);
                      }}
                    >
                      {proposal.content.title}
                    </button>
                    <span>Ticket created · approval still required</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <details class="work-review-history">
            <summary>
              Review history & evidence <span>{props.view.reviews.length}</span>
            </summary>
            <Show
              when={props.view.reviews.length}
              fallback={
                <p class="work-note">
                  No review yet. Selected work waits for the batch or age trigger.
                </p>
              }
            >
              <For each={props.view.reviews}>
                {(review) => (
                  <details class="work-review" id={`work-review-${review.id}`}>
                    <summary>
                      <span>
                        {review.kind === "calibration"
                          ? "Judge calibration"
                          : `${review.cases.length} work ${review.cases.length === 1 ? "case" : "cases"}`}
                      </span>
                      <span>
                        {review.kind === "calibration" && review.state === "completed"
                          ? review.calibrated
                            ? "Passed"
                            : "Not calibrated"
                          : review.state}
                      </span>
                    </summary>
                    <p class="work-note">
                      {review.modelId} · {review.rubric} ·{" "}
                      {new Date(review.createdAt).toLocaleString()}
                    </p>
                    <Show when={review.reason}>
                      <p role="status">{review.reason}</p>
                    </Show>
                    <For each={review.result?.cases ?? []}>
                      {(result) => (
                        <div class="work-case-result">
                          <p>
                            <strong>
                              {result.fulfillment === "supported"
                                ? "Supported"
                                : result.fulfillment === "problem"
                                  ? "Problem"
                                  : "Insufficient evidence"}
                            </strong>{" "}
                            · {result.explanation}
                          </p>
                          <code>{result.caseId}</code>
                        </div>
                      )}
                    </For>
                    <details>
                      <summary>Admitted evidence packet</summary>
                      <For each={review.cases}>
                        {(item, caseIndex) => (
                          <section
                            class="work-evidence-case"
                            tabindex="-1"
                            id={`work-case-${review.id}-${caseIndex()}`}
                          >
                            <h4>
                              {item.activity} · {item.outcome}
                            </h4>
                            <code>{item.id}</code>
                            <For each={item.evidence}>
                              {(evidence, evidenceIndex) => (
                                <details
                                  tabindex="-1"
                                  id={`work-evidence-${review.id}-${caseIndex()}-${evidenceIndex()}`}
                                >
                                  <summary>
                                    {evidence.kind} · {evidence.id}
                                    {evidence.truncated ? " · shortened" : ""}
                                  </summary>
                                  <pre>{evidence.body}</pre>
                                </details>
                              )}
                            </For>
                          </section>
                        )}
                      </For>
                    </details>
                  </details>
                )}
              </For>
            </Show>
          </details>
        </section>
      </Show>
    </section>
  );
}
