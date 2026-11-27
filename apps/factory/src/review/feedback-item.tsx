import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";
import type { z } from "zod";
import type { ReviewFeedback, reviewRegion } from "#conversation-domain/visual-review";
import { attachmentText, readAttachmentContent } from "../attachments/composer";
import { TextareaAttachments } from "../attachments/ui";
import { markdownHTML } from "../editor/client";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import { reviewTime } from "./playback";

function authorInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase();
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function feedbackThreadStatus(item: ReviewFeedback): string | undefined {
  if (item.state === "implemented") return "Ready to recheck";
  if (item.state === "resolved") return "Resolved";
  if (item.correctionState === "running") return "Revision in progress";
  if (item.correctionState === "sent") return "Revision sent";
  if (item.correctionState === "retry") return "Revision needs retry";
  return undefined;
}

export function FeedbackItem(props: {
  item: ReviewFeedback;
  mediaURL(id: string): string;
  canResolve: boolean;
  readOnly: boolean;
  previous: boolean;
  pinLabel: string;
  reply: string;
  onReply(value: string): void;
  canSeek: boolean;
  onSeek(): void;
  busy: boolean;
  onAction(action: string, body?: string): Promise<boolean>;
}) {
  const [replying, setReplying] = createSignal(untrack(() => Boolean(props.reply)));
  const [contextOpen, setContextOpen] = createSignal(false);
  const [thumbnailFailed, setThumbnailFailed] = createSignal(false);
  let replyInput: HTMLTextAreaElement | undefined;
  let replyToggle: HTMLButtonElement | undefined;
  let source: HTMLDivElement | undefined;
  let sourceOpener: HTMLButtonElement | undefined;
  let contextPanel: HTMLDivElement | undefined;
  const contextID = `feedback-context-${crypto.randomUUID()}`;
  createEffect(contextOpen, (shown) => {
    if (!shown) return;
    const position = () => {
      if (!source || !contextPanel) return;
      let top = 8;
      let bottom = innerHeight - 8;
      for (let parent = source.parentElement; parent; parent = parent.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) continue;
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top + 8);
        bottom = Math.min(bottom, bounds.bottom - 8);
      }
      const anchor = source.getBoundingClientRect();
      const above = Math.max(0, anchor.top - top - 4);
      const below = Math.max(0, bottom - anchor.bottom - 4);
      const openAbove = below < Math.min(384, contextPanel.scrollHeight) && above > below;
      contextPanel.dataset["placement"] = openAbove ? "above" : "below";
      contextPanel.style.maxHeight = `${Math.min(384, openAbove ? above : below)}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (contextPanel) observer.observe(contextPanel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    source?.addEventListener("load", position, true);
    const outside = (event: PointerEvent) => {
      if (!source?.contains(event.target as Node)) setContextOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    const dispose = contextPanel
      ? bindPopoverKeyboard(contextPanel, sourceOpener, () => setContextOpen(false))
      : undefined;
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      source?.removeEventListener("load", position, true);
      window.removeEventListener("pointerdown", outside);
      dispose?.();
    };
  });
  createEffect(
    () => props.reply,
    (value) => {
      if (value) setReplying(true);
    },
  );
  createEffect(replying, (shown) => {
    if (shown) queueMicrotask(() => replyInput?.focus());
  });
  const representation = () => {
    const annotation = props.item.annotation;
    return annotation?.source === "preview" ? annotation.representation : undefined;
  };
  const timestamp = () => {
    const annotation = props.item.annotation;
    return annotation?.source === "recording" ? annotation.timestampMs : undefined;
  };
  const status = () => feedbackThreadStatus(props.item);
  const readyForRecheck = () =>
    props.item.kind === "thread" &&
    props.item.state !== "resolved" &&
    (props.item.state === "implemented" || props.item.correctionState === "sent");
  const replyMessage = (message: Accessor<ReviewFeedback["messages"][number]>) => (
    <div class="review-message">
      <header class="review-message-heading">
        <span class="review-avatar" aria-hidden="true">
          {authorInitials(message().author)}
        </span>
        <div class="review-message-byline">
          <strong>{message().author}</strong>
          <time datetime={message().createdAt}>{formatMessageTime(message().createdAt)}</time>
        </div>
      </header>
      <div class="review-message-body markdown-body" innerHTML={markdownHTML(message().body)} />
    </div>
  );
  return (
    <article
      id={`review-feedback-${props.item.id}`}
      class="review-feedback"
      tabindex="-1"
      aria-label={`${props.item.kind} by ${props.item.author}`}
    >
      <header class="review-message-heading">
        <span class="review-avatar" aria-hidden="true">
          {authorInitials(props.item.author)}
        </span>
        <div class="review-message-byline">
          <strong>{props.item.author}</strong>
          <time
            datetime={props.item.createdAt}
            title={`${formatMessageTime(props.item.createdAt)} · ${props.previous ? "Earlier source basis" : "Source basis"} ${props.item.commitSha.slice(0, 8)}`}
          >
            {formatMessageTime(props.item.createdAt)}
          </time>
        </div>
        <Show when={props.item.kind === "thread" && status()}>
          <span class={`review-thread-state is-${props.item.state}`}>{status()}</span>
        </Show>
      </header>
      <div class="review-message-content">
        <Show when={props.item.annotation}>
          <div class="review-source" ref={source}>
            <Show when={props.canSeek}>
              <button
                type="button"
                class="review-text-action review-seek"
                onClick={() => {
                  setContextOpen(false);
                  props.onSeek();
                }}
              >
                <Icon name="play" />
                Video · {reviewTime((timestamp() ?? 0) / 1000, true)}
              </button>
            </Show>
            <button
              type="button"
              class="review-text-action review-context-trigger"
              ref={sourceOpener}
              aria-expanded={contextOpen() ? "true" : "false"}
              aria-controls={contextID}
              aria-haspopup="dialog"
              aria-label={props.canSeek ? "View saved QA frame" : undefined}
              title={
                representation() === "dom-reconstruction"
                  ? "Reconstructed element context"
                  : "Saved feedback context"
              }
              onClick={() => setContextOpen((shown) => !shown)}
            >
              <Show when={!thumbnailFailed() && props.item.annotation?.mediaId}>
                {(mediaID) => (
                  <img
                    class="review-context-thumbnail"
                    src={props.mediaURL(mediaID())}
                    alt=""
                    loading="lazy"
                    onError={() => setThumbnailFailed(true)}
                  />
                )}
              </Show>
              <Show when={!props.canSeek} fallback={<span class="sr-only">Saved QA frame</span>}>
                {props.item.annotation?.source === "preview"
                  ? `Live Preview${props.item.annotation.element ? ` · ${props.item.annotation.element}` : ""}`
                  : `Video · ${reviewTime((timestamp() ?? 0) / 1000, true)}`}
              </Show>
              <Show when={props.canSeek && thumbnailFailed()}>
                <Icon name="preview" />
              </Show>
            </button>
            <Show when={contextOpen()}>
              <div
                class="review-source-popover"
                id={contextID}
                ref={contextPanel}
                role="dialog"
                aria-label="Saved feedback context"
              >
                <header class="review-context-heading">
                  <strong>
                    {representation() === "dom-reconstruction"
                      ? "Reconstructed element context"
                      : "Saved feedback context"}
                  </strong>
                  <button
                    type="button"
                    class="bare-icon"
                    aria-label="Close context"
                    title="Close context"
                    onClick={() => {
                      setContextOpen(false);
                      sourceOpener?.focus();
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </header>
                <small>
                  {props.previous ? "Earlier source basis · " : "Source basis · "}
                  {props.item.commitSha.slice(0, 8)}
                </small>
                <Show when={props.item.annotation}>
                  {(annotation) => (
                    <>
                      <Show
                        when={annotation().mediaId}
                        fallback={
                          <p>No context image. The page and element anchor are retained.</p>
                        }
                      >
                        {(mediaID) => (
                          <div class="review-saved-frame-window">
                            <FrameRegion
                              image={props.mediaURL(mediaID())}
                              region={
                                representation() === "dom-reconstruction"
                                  ? undefined
                                  : annotation().region
                              }
                              pinLabel={props.pinLabel}
                              reconstructed={representation() === "dom-reconstruction"}
                            />
                          </div>
                        )}
                      </Show>
                      <small>{annotation().page}</small>
                      <Show when={annotation().source === "preview"}>
                        <p class="review-context-note">
                          Preview context, not clean-candidate proof.
                        </p>
                      </Show>
                      <Show when={representation() === "dom-reconstruction"}>
                        <p class="review-context-note">
                          DOM reconstruction. It can differ from the browser's pixels and is not a
                          replay of the current Preview.
                        </p>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </Show>
        <div
          class="review-message-body markdown-body"
          innerHTML={markdownHTML(props.item.messages[0]?.body ?? "")}
        />
        <Show when={props.item.messages.length > 1}>
          <div class="review-replies">
            <div class="review-reply-list">
              <Show when={props.item.messages.length > 2}>
                <details class="review-earlier-replies">
                  <summary>
                    {props.item.messages.length - 2} earlier{" "}
                    {props.item.messages.length === 3 ? "reply" : "replies"}
                  </summary>
                  <div class="review-earlier-reply-list">
                    <For each={props.item.messages.slice(1, -1)} keyed={(message) => message.id}>
                      {replyMessage}
                    </For>
                  </div>
                </details>
              </Show>
              <For each={props.item.messages.slice(-1)} keyed={(message) => message.id}>
                {replyMessage}
              </For>
            </div>
          </div>
        </Show>
        <Show when={!props.readOnly}>
          <div class="review-feedback-actions">
            <button
              type="button"
              class="review-text-action"
              ref={replyToggle}
              aria-expanded={replying() ? "true" : "false"}
              disabled={props.busy}
              onClick={() => setReplying((value) => !value)}
            >
              Reply
            </button>
            <Show when={props.item.kind === "thread" && props.canResolve}>
              <button
                type="button"
                class={
                  readyForRecheck()
                    ? "review-text-action review-resolve-action is-recheck"
                    : "review-text-action"
                }
                disabled={props.busy}
                onClick={() =>
                  void props.onAction(props.item.state === "resolved" ? "reopen" : "resolve")
                }
              >
                {props.item.state === "resolved" ? "Reopen Thread" : "Resolve Thread"}
              </button>
              <Show when={readyForRecheck()}>
                <button
                  type="button"
                  class="review-text-action review-reopen-action"
                  disabled={props.busy}
                  onClick={() => void props.onAction("reopen")}
                >
                  Needs changes
                </button>
              </Show>
            </Show>
          </div>
          <Show when={replying()}>
            <form
              class="review-reply-composer"
              onSubmit={async (event) => {
                event.preventDefault();
                const submitted = props.reply;
                if ((await props.onAction("reply", submitted)) && props.reply === submitted) {
                  props.onReply("");
                  setReplying(false);
                  replyToggle?.focus();
                }
              }}
            >
              <TextareaAttachments
                disabled={props.busy}
                scopeKey={`feedback:${props.item.id}:reply`}
                privacy="feedback"
                content={props.reply}
              >
                <label>
                  Reply to {props.item.author}
                  <textarea
                    ref={replyInput}
                    value={attachmentText(props.reply)}
                    maxlength={2000}
                    onInput={(event) => props.onReply(readAttachmentContent(event.currentTarget))}
                  />
                </label>
              </TextareaAttachments>
              <button
                type="submit"
                class="quiet-button"
                disabled={props.busy || !props.reply.trim()}
              >
                Add reply
              </button>
            </form>
          </Show>
        </Show>
      </div>
    </article>
  );
}

export function FrameRegion(props: {
  image: string;
  region?: z.infer<typeof reviewRegion> | undefined;
  pinLabel?: string;
  reconstructed?: boolean;
}) {
  const imageSource = createMemo(() => props.image);
  return (
    <div class={`review-frame ${props.reconstructed ? "is-reconstructed" : ""}`}>
      <img
        src={imageSource()}
        alt={
          props.reconstructed
            ? "DOM reconstruction of the selected element"
            : "Original review frame"
        }
        draggable={false}
      />
      <Show when={props.region}>
        {(region) => (
          <span
            class={`review-region ${region().width < 0.01 && region().height < 0.01 ? "is-point" : ""}`}
            style={{
              left: `${region().x * 100}%`,
              top: `${region().y * 100}%`,
              "--review-region-width": `${region().width * 100}%`,
              "--review-region-height": `${region().height * 100}%`,
            }}
          />
        )}
      </Show>
      <Show when={props.pinLabel}>
        <span
          class="review-author-pin"
          style={{
            left: `${Math.min(70, (props.region?.x ?? 0.02) * 100)}%`,
            top: `${Math.min(90, (props.region?.y ?? 0.02) * 100)}%`,
          }}
        >
          {props.pinLabel}
        </span>
      </Show>
    </div>
  );
}
