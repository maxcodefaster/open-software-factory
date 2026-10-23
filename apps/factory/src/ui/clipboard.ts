import { createEffect, createSignal, onCleanup } from "solid-js";
import { copyFeedbackLabel, type FeedbackState, feedbackAcknowledgementMs } from "./feedback-state";

// Clipboard requests cannot be cancelled. Scope and request identity fence their UI results.
export function createClipboardFeedback(scope: () => unknown) {
  const [state, setState] = createSignal<FeedbackState>("idle");
  let request = 0;
  let busy = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function reset() {
    request += 1;
    busy = false;
    clearTimeout(timer);
    setState("idle");
  }
  createEffect(scope, reset);
  onCleanup(() => {
    disposed = true;
    request += 1;
    clearTimeout(timer);
  });
  return {
    state,
    async copy(text: string) {
      if (busy || disposed) return;
      const identity = scope();
      const current = ++request;
      const active = () => !disposed && request === current && scope() === identity;
      busy = true;
      clearTimeout(timer);
      setState("pending");
      try {
        await navigator.clipboard.writeText(text);
        if (!active()) return;
        setState("success");
        timer = setTimeout(() => {
          if (active()) setState("idle");
        }, feedbackAcknowledgementMs);
      } catch {
        if (active()) setState("error");
      } finally {
        if (active()) busy = false;
      }
    },
  };
}

// Markdown code controls are generated HTML, so they use the same feedback through this adapter.
export function setCopyButtonState(button: HTMLButtonElement, state: FeedbackState) {
  button.dataset["feedback"] = state;
  button.setAttribute("aria-busy", String(state === "pending"));
  const label = button.querySelector("[data-copy-label]");
  if (label) label.textContent = copyFeedbackLabel(state);
}
