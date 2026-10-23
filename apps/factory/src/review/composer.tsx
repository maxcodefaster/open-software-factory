import { createEffect, Show } from "solid-js";
import { Icon } from "../icon";
import { TextareaAttachments } from "../attachments/ui";
import { attachmentText, readAttachmentContent } from "../attachments/composer";

export function ReviewComposer(props: {
  attachmentScopeKey: string;
  body: string;
  kind: "comment" | "thread";
  busy: boolean;
  locked: boolean;
  active: boolean;
  reveal?: boolean;
  source?: string | undefined;
  image?: string | undefined;
  reconstructed?: boolean;
  onBody(value: string): void;
  onKind(value: "comment" | "thread"): void;
  onSubmit(event: SubmitEvent): void;
  onCancel(): void;
  onDismiss(): void;
}) {
  let input: HTMLTextAreaElement | undefined;
  createEffect(
    () => props.active && !props.locked,
    (ready) => {
      if (ready)
        queueMicrotask(() => {
          if (!input?.isConnected) return;
          if (props.reveal) input.form?.scrollIntoView({ block: "nearest" });
          input.focus({ preventScroll: true });
        });
    },
  );
  return (
    <form
      class="review-composer"
      aria-label="Add review feedback"
      onSubmit={props.onSubmit}
      onKeyDown={(event) => {
        if (props.busy || props.locked) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <header class="review-composer-heading">
        <strong>New feedback</strong>
        <button
          type="button"
          class="quiet-button icon-button"
          aria-label="Cancel feedback"
          disabled={props.busy || props.locked}
          onClick={props.onCancel}
        >
          <Icon name="close" />
        </button>
      </header>
      <Show when={props.source}>
        <p class="review-composer-source">{props.source}</p>
      </Show>
      <TextareaAttachments
        disabled={props.busy || props.locked}
        scopeKey={props.attachmentScopeKey}
        privacy="feedback"
        content={props.body}
      >
        <label>
          <span class="sr-only">Review comment</span>
          <textarea
            ref={input}
            aria-label="Review comment"
            value={attachmentText(props.body)}
            maxlength={2000}
            disabled={props.busy || props.locked}
            onInput={(event) => props.onBody(readAttachmentContent(event.currentTarget))}
            placeholder="What should change?"
          />
        </label>
      </TextareaAttachments>
      <Show when={props.image}>
        <figure class="review-context-preview">
          <figcaption>
            {props.reconstructed ? "Reconstructed element context" : "Captured QA frame"}
          </figcaption>
          <img
            src={props.image}
            alt={
              props.reconstructed
                ? "DOM reconstruction of the selected element"
                : "Captured QA frame"
            }
          />
        </figure>
      </Show>
      <div class="review-composer-actions">
        <label class="review-kind">
          <span class="sr-only">Feedback type</span>
          <select
            aria-label="Feedback type"
            value={props.kind}
            disabled={props.busy || props.locked}
            onChange={(event) => props.onKind(event.currentTarget.value as "comment" | "thread")}
          >
            <option value="comment">Comment</option>
            <option value="thread">Thread</option>
          </select>
        </label>
        <button
          type="submit"
          class="primary-button"
          disabled={props.busy || props.locked || !props.body.trim()}
        >
          {props.busy ? "Saving…" : "Save feedback"}
        </button>
      </div>
      <p class="review-composer-note">
        {props.kind === "thread"
          ? "Blocks Delivery until resolved. Saving does not start work."
          : "Saving feedback does not start agent work."}
      </p>
    </form>
  );
}
