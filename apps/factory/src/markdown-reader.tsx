import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { markdownHTML } from "./markdown";
import { createClipboardFeedback, setCopyButtonState } from "./ui/clipboard";
import "./ui/feedback.css";

export function MarkdownReader(props: {
  value: string;
  label: string;
  scopeKey?: string | undefined;
  class: string;
  onEdit?: (() => void) | undefined;
  onNavigate?: ((href: string) => boolean) | undefined;
}) {
  const scope = createMemo(() => ({ value: props.value, key: props.scopeKey }));
  const clipboard = createClipboardFeedback(scope);
  const [copyButton, setCopyButton] = createSignal<HTMLButtonElement>();
  createEffect(
    () => ({ button: copyButton(), state: clipboard.state() }),
    (current, previous) => {
      if (previous?.button && previous.button !== current.button)
        setCopyButtonState(previous.button, "idle");
      if (current.button) setCopyButtonState(current.button, current.state);
    },
  );
  onCleanup(() => {
    const button = copyButton();
    if (button) setCopyButtonState(button, "idle");
  });
  return (
    <>
      <article
        class={props.class}
        tabindex={props.onEdit ? "0" : undefined}
        aria-label={props.label}
        innerHTML={markdownHTML(props.value, true)}
        onClick={async (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const link = target.closest<HTMLAnchorElement>("a");
          if (
            link &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey &&
            props.onNavigate?.(link.getAttribute("href") ?? "")
          ) {
            event.preventDefault();
            return;
          }
          const button = target.closest<HTMLButtonElement>('button[aria-label="Copy code"]');
          if (button) {
            if (clipboard.state() === "pending") return;
            setCopyButton(button);
            await clipboard.copy(button.closest("pre")?.querySelector("code")?.textContent ?? "");
            return;
          }
          if (!target.closest("a,input,button")) props.onEdit?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget && props.onEdit) {
            event.preventDefault();
            props.onEdit();
          }
        }}
      />
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {clipboard.state() === "success" ? "Code copied" : ""}
      </span>
      <Show when={clipboard.state() === "error"}>
        <small class="copy-feedback-error" role="alert">
          Could not copy. Select the code to copy manually.
        </small>
      </Show>
    </>
  );
}
