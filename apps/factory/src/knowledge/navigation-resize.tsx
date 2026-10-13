import { createEffect, createSignal } from "solid-js";

const minimum = 168;
const maximum = 360;
const initial = 224;
const bounded = (value: number) => Math.min(maximum, Math.max(minimum, value));

export function WikiNavigationResize(props: {
  projectID: string;
  workspace(): HTMLDivElement | undefined;
}) {
  const [width, setWidth] = createSignal(initial);
  createEffect(
    () => props.projectID,
    (id) => {
      let value = initial;
      try {
        value = Number(localStorage.getItem(`wiki-width:${id}`)) || initial;
      } catch {
        /* Optional storage. */
      }
      setWidth(bounded(value));
    },
  );
  createEffect(width, (value) =>
    props.workspace()?.style.setProperty("--wiki-nav-width", `${value}px`),
  );
  function update(value: number) {
    const next = bounded(value);
    setWidth(next);
    try {
      localStorage.setItem(`wiki-width:${props.projectID}`, String(next));
    } catch {
      /* Resizing remains available. */
    }
  }
  let origin: { x: number; width: number } | undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: An adjustable window splitter is not a document rule.
    // biome-ignore lint/a11y/useFocusableInteractive: Solid uses lowercase tabindex, which is present below.
    <div
      class="wiki-navigation-resize"
      role="separator"
      tabindex="0"
      aria-label="Wiki navigation width"
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={width()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        origin = { x: event.clientX, width: width() };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (origin) update(origin.width + event.clientX - origin.x);
      }}
      onPointerUp={() => {
        origin = undefined;
      }}
      onLostPointerCapture={() => {
        origin = undefined;
      }}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? width() - 16
            : event.key === "ArrowRight"
              ? width() + 16
              : event.key === "Home"
                ? minimum
                : event.key === "End"
                  ? maximum
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        update(next);
      }}
    />
  );
}
