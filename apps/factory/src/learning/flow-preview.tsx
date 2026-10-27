import { createEffect, Show } from "solid-js";
import { editorPopoverPosition } from "../editor-popover-position";
import type { LearningFlowRecord } from "./flow";

export function LearningFlowPreview(props: {
  id: string;
  record: LearningFlowRecord | undefined;
  anchor: HTMLButtonElement | undefined;
  onHold: () => void;
  onLeave: () => void;
  onDismiss: () => void;
}) {
  let panel: HTMLDivElement | undefined;
  createEffect(
    () => ({ record: props.record, anchor: props.anchor }),
    ({ record, anchor }) => {
      const popup = panel;
      if (!popup || !record || !anchor) return;
      let disposed = false;
      let frame = 0;
      const position = () => {
        const button = anchor.getBoundingClientRect();
        const label = anchor.querySelector(".learning-flow-label")?.getBoundingClientRect();
        const bounds = {
          left: Math.min(button.left, label?.left ?? button.left),
          right: Math.max(button.right, label?.right ?? button.right),
          top: Math.min(button.top, label?.top ?? button.top),
          bottom: Math.max(button.bottom, label?.bottom ?? button.bottom),
        };
        const box = popup.getBoundingClientRect();
        const column = anchor.closest(".learning-flow")?.getBoundingClientRect();
        const left = Math.max(12, column?.left ?? 12);
        const right = Math.min(innerWidth - 12, column?.right ?? innerWidth - 12);
        const fitsColumn = right - left >= box.width;
        const point = editorPopoverPosition({
          anchor: bounds,
          bounds: {
            left: fitsColumn ? left : 12,
            right: fitsColumn ? right : innerWidth - 12,
            top: 12,
            bottom: innerHeight - 12,
          },
          width: box.width,
          height: box.height,
          gap: 8,
          preferBelow: false,
          align: "center",
        });
        popup.style.left = `${point.left}px`;
        popup.style.top = `${point.top}px`;
      };
      const schedulePosition = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(position);
      };
      const dismissOnEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onDismiss();
      };
      queueMicrotask(() => {
        if (disposed || !popup.isConnected) return;
        popup.showPopover();
        position();
      });
      const observer = new ResizeObserver(schedulePosition);
      observer.observe(popup);
      observer.observe(anchor);
      window.addEventListener("resize", props.onDismiss);
      window.addEventListener("scroll", props.onDismiss, true);
      window.addEventListener("blur", props.onDismiss);
      window.addEventListener("keydown", dismissOnEscape, true);
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("resize", props.onDismiss);
        window.removeEventListener("scroll", props.onDismiss, true);
        window.removeEventListener("blur", props.onDismiss);
        window.removeEventListener("keydown", dismissOnEscape, true);
        if (popup.matches(":popover-open")) popup.hidePopover();
      };
    },
  );
  return (
    <div
      ref={panel}
      id={props.id}
      popover="manual"
      role="tooltip"
      class="learning-flow-preview"
      data-tone={props.record?.tone}
      onPointerEnter={props.onHold}
      onPointerLeave={props.onLeave}
    >
      <Show when={props.record}>
        {(record) => (
          <>
            <p class="learning-flow-meta">
              <span>{record().target}</span>
              <span class="learning-flow-outcome">{record().status}</span>
            </p>
            <strong>{record().title}</strong>
            <p class="learning-flow-preview-description">
              {record().description.length > 240
                ? `${record().description.slice(0, 236).trimEnd()}…`
                : record().description}
            </p>
            <p class="learning-flow-preview-date">
              {record().dateLabel} ·{" "}
              {new Date(record().at).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "UTC",
              })}{" "}
              UTC
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
