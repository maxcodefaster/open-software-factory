import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { createClipboardFeedback } from "./clipboard";
import {
  copyFeedbackLabel,
  type FeedbackState,
  feedbackAcknowledgementMs,
  type SaveFeedbackState,
  saveFeedback,
} from "./feedback-state";
import "./feedback.css";

// Presentation only. The caller owns the outcome; nested live regions opt out of announcements.
export function Feedback(props: {
  state: FeedbackState;
  message: string;
  class?: string;
  announce?: boolean;
}) {
  return (
    <span
      class={`interaction-feedback${props.class ? ` ${props.class}` : ""}`}
      data-feedback={props.state}
      role={props.announce === false ? undefined : "status"}
      aria-live={props.announce === false ? undefined : "polite"}
      aria-atomic={props.announce === false ? undefined : "true"}
    >
      <span class="feedback-mark" aria-hidden="true" />
      <span>{props.message}</span>
    </span>
  );
}

// Only the acknowledgement expires. This never changes or retries the caller's save.
export function SaveFeedback(props: { state: SaveFeedbackState }) {
  const [expired, setExpired] = createSignal(false);
  createEffect(
    () => props.state,
    (state) => {
      setExpired(false);
      if (state !== "saved") return;
      const timer = setTimeout(() => setExpired(true), feedbackAcknowledgementMs);
      return () => clearTimeout(timer);
    },
  );
  const feedback = () => saveFeedback(props.state === "saved" && expired() ? "idle" : props.state);
  return <Feedback class="save-feedback" state={feedback().state} message={feedback().message} />;
}

export function CopyButton(props: {
  value: string;
  label?: string;
  accessibleLabel?: string;
  scope?: unknown;
  class?: string;
  disabled?: boolean;
  successMessage?: string;
  errorMessage?: string;
}) {
  const scope = createMemo(() => ({ value: props.value, owner: props.scope }));
  const clipboard = createClipboardFeedback(scope);
  const error = () => props.errorMessage ?? "Could not copy. Select the text to copy manually.";
  return (
    <>
      <button
        type="button"
        class={`copy-feedback${props.class ? ` ${props.class}` : ""}`}
        aria-label={props.accessibleLabel ?? props.label ?? "Copy"}
        aria-busy={clipboard.state() === "pending" ? "true" : "false"}
        data-feedback={clipboard.state()}
        disabled={props.disabled}
        onClick={() => void clipboard.copy(props.value)}
      >
        <span class="feedback-mark" aria-hidden="true" />
        <span class="copy-feedback-label" aria-hidden="true">
          <span class="copy-feedback-reserve">{props.label ?? "Copy"}</span>
          <span>{copyFeedbackLabel(clipboard.state(), props.label)}</span>
        </span>
      </button>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {clipboard.state() === "success" ? (props.successMessage ?? "Copied") : ""}
      </span>
      <Show when={clipboard.state() === "error"}>
        <span class="copy-feedback-error" role="alert">
          {error()}
        </span>
      </Show>
    </>
  );
}
