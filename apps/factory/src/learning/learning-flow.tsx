import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { LearningView } from "../../../../packages/conversation-domain/src/learning";
import { learningFlowLayout, learningFlowRecords } from "./flow";
import { LearningFlowPreview } from "./flow-preview";
import "./learning-flow.css";

const day = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const timestamp = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
const label = (value: string) => {
  if (value.length <= 42) return value;
  return `${value.slice(0, 39).replace(/\s+\S*$/, "")}…`;
};
const description = (value: string) =>
  value.length <= 360 ? value : `${value.slice(0, 356).trimEnd()}…`;

export function LearningFlow(props: { view: LearningView; onInspect: (detailId: string) => void }) {
  let field: HTMLDivElement | undefined;
  const id = `learning-flow-${createUniqueId()}`;
  const previewId = `${id}-preview`;
  const anchors = new Map<string, HTMLButtonElement>();
  type Pick = { scope: string; id: string };
  type PreviewPick = { snapshot: symbol; id: string };
  const [width, setWidth] = createSignal(640);
  const [selection, setSelection] = createSignal<Pick>();
  const [hovered, setHovered] = createSignal<PreviewPick>();
  const [focused, setFocused] = createSignal<PreviewPick>();
  const [pulse, setPulse] = createSignal<{ snapshot: symbol }>();
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const scope = () => `${props.view.projectId}:${props.view.scope}`;
  const snapshot = createMemo(() => {
    const view = props.view;
    return Symbol(`${view.projectId}:${view.scope}`);
  });
  const history = createMemo(() => learningFlowRecords(props.view));
  const records = createMemo(() => history().slice(-4));
  const count = createMemo(() => records().length);
  const layout = createMemo(() => learningFlowLayout(width(), count()));
  const current = () =>
    records().find((record) => selection()?.scope === scope() && record.id === selection()?.id) ??
    records().at(-1);
  const preview = () => {
    const context = snapshot();
    const pick = [hovered(), focused()].find((pick) => pick?.snapshot === context);
    return pick ? records().find((record) => record.id === pick.id) : undefined;
  };
  const trace = () => {
    const interaction = pulse();
    return interaction?.snapshot === snapshot() ? [interaction] : [];
  };
  const active = () => preview() ?? current();
  const currentTimestamp = () => {
    const record = current();
    return record ? timestamp(record.at) : "";
  };
  const activeSegment = () =>
    layout().selections[records().findIndex((record) => record.id === active()?.id)];
  const activePaths = () => activeSegment()?.paths ?? [];
  const holdPreview = () => clearTimeout(hideTimer);
  const dismissPreview = () => {
    holdPreview();
    setHovered(undefined);
    setFocused(undefined);
    setPulse(undefined);
  };
  const leavePreview = () => {
    holdPreview();
    hideTimer = setTimeout(() => {
      setHovered(undefined);
      setPulse(undefined);
    }, 120);
  };
  function previewRecord(recordId: string, keyboard = false) {
    holdPreview();
    if (preview()?.id !== recordId) setPulse({ snapshot: snapshot() });
    if (keyboard) setHovered(undefined);
    (keyboard ? setFocused : setHovered)({ snapshot: snapshot(), id: recordId });
  }
  onCleanup(holdPreview);
  createEffect(
    () => true,
    () => {
      let disposed = false;
      let observer: ResizeObserver | undefined;
      let frame = 0;
      queueMicrotask(() => {
        if (disposed || !field) return;
        observer = new ResizeObserver(([entry]) => {
          if (!entry?.contentRect.width) return;
          const measured = Math.round(entry.contentRect.width);
          cancelAnimationFrame(frame);
          if (measured === width()) return;
          dismissPreview();
          // Width changes can also change the field's height on narrow screens.
          // Publish outside this observer delivery to avoid a resize feedback loop.
          frame = requestAnimationFrame(() => setWidth(measured));
        });
        observer.observe(field);
      });
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        observer?.disconnect();
      };
    },
  );
  return (
    <section class="learning-flow" aria-label="Learning history overview">
      <header class="learning-flow-heading">
        <h3>Learning history</h3>
        <p>{props.view.scope === "personal" ? "Your private work" : "Shared Project work"}</p>
      </header>
      <div
        class="learning-flow-field"
        ref={field}
        data-mobile={layout().mobile ? "true" : "false"}
        data-tone={active()?.tone ?? "quiet"}
        data-active-record={active()?.id}
        style={{ height: records().length ? `${layout().height}px` : undefined }}
      >
        <Show
          when={records().length}
          fallback={
            <p class="learning-flow-empty">
              Review decisions will appear here after eligible work is reviewed. Opening this page
              starts no AI call.
            </p>
          }
        >
          <svg
            class="learning-flow-drawing"
            viewBox={`0 0 ${layout().width} ${layout().height}`}
            role="img"
            aria-label="Recent learning records in chronological order. Threads are schematic, not run counts or a quality score. Use the labeled buttons to inspect each record."
          >
            <defs>
              <linearGradient
                id={`${id}-highlight`}
                gradientUnits="userSpaceOnUse"
                x1={activeSegment()?.start.x ?? 0}
                y1={activeSegment()?.start.y ?? 0}
                x2={activeSegment()?.end.x ?? 0}
                y2={activeSegment()?.end.y ?? 0}
              >
                <stop offset="0%" stop-color="var(--flow-active)" stop-opacity="0" />
                <stop offset="18%" stop-color="var(--flow-active)" />
                <stop offset="82%" stop-color="var(--flow-active)" />
                <stop offset="100%" stop-color="var(--flow-active)" stop-opacity="0" />
              </linearGradient>
            </defs>
            <For each={layout().threads}>
              {(path) => <path class="learning-flow-thread" d={path} />}
            </For>
            <For each={activePaths()}>
              {(path) => (
                <path
                  class="learning-flow-thread learning-flow-highlight"
                  d={path}
                  style={{ stroke: `url(#${id}-highlight)` }}
                />
              )}
            </For>
            <For each={trace()}>
              {() => <path class="learning-flow-trace" d={activePaths()[6] ?? ""} pathLength="1" />}
            </For>
          </svg>
          <For each={records()} keyed={(record) => record.id}>
            {(record, index) => {
              const recordId = untrack(() => record().id);
              const node = () => {
                const value = layout().nodes[index()];
                if (!value) throw new Error("The learning record has no layout node");
                return value;
              };
              onCleanup(() => anchors.delete(recordId));
              return (
                <button
                  ref={(element) => {
                    anchors.set(recordId, element);
                  }}
                  type="button"
                  class="learning-flow-node"
                  aria-pressed={current()?.id === recordId ? "true" : "false"}
                  aria-label={`${day(record().at)}: ${record().title}. ${record().status}`}
                  aria-describedby={preview()?.id === recordId ? previewId : undefined}
                  data-tone={record().tone}
                  data-mark={record().mark}
                  data-preview={preview()?.id === recordId ? "true" : "false"}
                  style={{ left: `${node().x - 22}px`, top: `${node().y - 22}px` }}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch") previewRecord(recordId);
                  }}
                  onPointerLeave={leavePreview}
                  onFocus={() => previewRecord(recordId, true)}
                  onBlur={() => {
                    setFocused(undefined);
                    setPulse(undefined);
                  }}
                  onClick={() => {
                    dismissPreview();
                    setSelection({ scope: scope(), id: recordId });
                    setPulse({ snapshot: snapshot() });
                  }}
                >
                  <span class="learning-flow-seed" aria-hidden="true" />
                  <span
                    class="learning-flow-label"
                    style={{
                      left: `${node().label.x - node().x + 22}px`,
                      top: `${node().label.y - node().y + 22}px`,
                      width: `${node().label.width}px`,
                    }}
                  >
                    <span class="learning-flow-date">{day(record().at)}</span>
                    <span class="learning-flow-name">{label(record().title)}</span>
                    <span class="learning-flow-status">{record().status}</span>
                  </span>
                </button>
              );
            }}
          </For>
        </Show>
      </div>
      <Show when={current()}>
        <p class="learning-flow-caption">
          Latest {records().length} of {history().length} records · Oldest first · UTC
          <span>Connections show order, not measured improvement.</span>
        </p>
        <div class="learning-flow-detail" data-tone={current()?.tone}>
          <div aria-live="polite" aria-atomic="true">
            <p class="learning-flow-meta">
              <span>{current()?.target}</span>
              <span class="learning-flow-outcome">{current()?.status}</span>
            </p>
            <h4>{current()?.title}</h4>
            <p class="learning-flow-description">{description(current()?.description ?? "")}</p>
            <p class="learning-flow-timestamp">
              {current()?.dateLabel} · {currentTimestamp()} UTC
            </p>
          </div>
          <button
            type="button"
            class="text-button learning-flow-inspect"
            onClick={() => {
              dismissPreview();
              const record = current();
              if (record) props.onInspect(record.detailId);
            }}
          >
            Inspect decision &amp; evidence
          </button>
        </div>
      </Show>
      <LearningFlowPreview
        id={previewId}
        record={preview()}
        anchor={anchors.get(preview()?.id ?? "")}
        onHold={holdPreview}
        onLeave={leavePreview}
        onDismiss={dismissPreview}
      />
    </section>
  );
}
