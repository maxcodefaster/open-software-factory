import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Icon } from "../icon";

export function AttachmentFiles(props: {
  horizontal: boolean;
  count: number;
  scope: string;
  children: JSX.Element;
}) {
  const id = `attachment-files-${crypto.randomUUID()}`;
  const [overflow, setOverflow] = createSignal(false);
  const [left, setLeft] = createSignal(false);
  const [right, setRight] = createSignal(false);
  let list: HTMLUListElement | undefined;
  let shell: HTMLDivElement | undefined;
  let resize: ResizeObserver | undefined;
  let disposed = false;
  const measure = () => {
    if (!list || disposed) return;
    setOverflow(list.scrollWidth > (shell?.clientWidth ?? list.clientWidth) + 1);
    setLeft(list.scrollLeft > 1);
    setRight(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
  };
  const scroll = (direction: number) =>
    list?.scrollBy({ left: direction * list.clientWidth * 0.8 });
  createEffect(
    () => [props.count, props.scope] as const,
    (current, previous) => {
      queueMicrotask(() => {
        if (disposed) return;
        if (list && current[1] !== previous?.[1]) list.scrollLeft = 0;
        measure();
      });
    },
  );
  onCleanup(() => {
    disposed = true;
    resize?.disconnect();
  });
  return (
    <div class={`attachment-files${props.horizontal ? " attachment-strip" : ""}`} ref={shell}>
      <Show when={props.horizontal && overflow()}>
        <button
          type="button"
          class="quiet-button attachment-scroll attachment-scroll-back"
          aria-label="Scroll attachments left"
          aria-controls={id}
          disabled={!left()}
          onClick={() => scroll(-1)}
        >
          <Icon name="chevron" />
        </button>
      </Show>
      <ul
        class="attachment-pending-list"
        aria-label="Prepared attachments"
        id={id}
        tabindex={props.horizontal ? 0 : undefined}
        ref={(element) => {
          list = element;
          resize = new ResizeObserver(measure);
          resize.observe(element);
          queueMicrotask(measure);
        }}
        onScroll={measure}
        onKeyDown={(event) => {
          if (!props.horizontal || event.target !== event.currentTarget) return;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            scroll(event.key === "ArrowLeft" ? -1 : 1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            event.currentTarget.scrollLeft =
              event.key === "Home" ? 0 : event.currentTarget.scrollWidth;
          }
        }}
      >
        {props.children}
      </ul>
      <Show when={props.horizontal && overflow()}>
        <button
          type="button"
          class="quiet-button attachment-scroll attachment-scroll-next"
          aria-label="Scroll attachments right"
          aria-controls={id}
          disabled={!right()}
          onClick={() => scroll(1)}
        >
          <Icon name="chevron" />
        </button>
      </Show>
    </div>
  );
}

// Native disclosure keeps format/size help available before selection on touch
// and keyboard, without turning routine composer metadata into several lines.
export function AttachmentHelp(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  let details: HTMLDetailsElement | undefined;
  let opener: HTMLElement | undefined;
  createEffect(
    () => open(),
    (shown) => {
      if (!shown) return;
      const outside = (event: Event) => {
        if (event.target instanceof Node && !details?.contains(event.target) && details)
          details.open = false;
      };
      document.addEventListener("pointerdown", outside);
      document.addEventListener("focusin", outside);
      return () => {
        document.removeEventListener("pointerdown", outside);
        document.removeEventListener("focusin", outside);
      };
    },
  );
  return (
    <details
      class="attachment-help"
      ref={details}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !details?.open) return;
        event.preventDefault();
        event.stopPropagation();
        details.open = false;
        opener?.focus({ preventScroll: true });
      }}
    >
      <summary
        aria-label="Attachment formats and limits"
        title="Attachment formats and limits"
        ref={opener}
      >
        <Icon name="info" />
      </summary>
      <div class="attachment-help-content">{props.children}</div>
    </details>
  );
}
