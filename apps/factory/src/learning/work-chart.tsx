import { createEffect, createSignal, For, Show } from "solid-js";
import type { LearningDay } from "#conversation-domain/learning";

export const money = (nano: string | number) =>
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

export const sum = (
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

export const waitingDate = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

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
        <section class="work-data-scroll" aria-label="Daily data" tabindex="0">
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
        </section>
      </details>
    </section>
  );
}
