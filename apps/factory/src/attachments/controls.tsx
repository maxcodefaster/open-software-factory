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
          title="Scroll attachments left"
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
          title="Scroll attachments right"
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
