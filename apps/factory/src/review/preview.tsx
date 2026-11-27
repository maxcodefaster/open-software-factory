import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Icon } from "../icon";
import { ReviewPanel } from "./panel";
import {
  activeFeedbackID,
  attachPreviewContextImage,
  buildPreviewPins,
  calculatePreviewPopoverPosition,
  createPreviewCapture,
  ensurePopoverMounted,
  hasPreviewDraft,
  isPopoverMounted,
  isPopoverOpen,
  type PreviewBridgeMode,
  type PreviewDocumentState,
  type PreviewDraftState,
  type PreviewPopoverState,
  type PreviewReviewData,
  parsePreviewBridgeMessage,
  previewHintMessage,
  previewToggleLabel,
  readPreviewTheme,
} from "./preview-state";

export function PreviewReview(props: {
  projectID?: string | undefined;
  changeID: string;
  attemptID: string;
  userID: string;
  canDevelop: boolean;
  frame(): HTMLIFrameElement | undefined;
  runtimeOrigin: string;
  active: boolean;
  onOpenTicket?: (() => void) | undefined;
}) {
  const [bridgeMode, setBridgeMode] = createSignal<PreviewBridgeMode>({ kind: "idle" });
  const [popover, setPopover] = createSignal<PreviewPopoverState>({ kind: "unmounted" });
  const [previewDoc, setPreviewDoc] = createSignal<PreviewDocumentState>({ kind: "unloaded" });
  const [draft, setDraft] = createSignal<PreviewDraftState>({ capture: undefined, dirty: false });
  const [reviewData, setReviewData] = createSignal<PreviewReviewData>({
    feedback: [],
    readOnly: false,
  });
  const [error, setError] = createSignal("");
  const [position, setPosition] = createSignal({ x: 16, y: 64 });
  const token = crypto.randomUUID();
  let toggle: HTMLButtonElement | undefined;
  let feedbackHeading: HTMLHeadingElement | undefined;
  let readiness: ReturnType<typeof setTimeout> | undefined;

  const commenting = () => bridgeMode().kind !== "idle";
  const popup = () => isPopoverOpen(popover());
  const feedbackID = () => activeFeedbackID(popover());
  const send = (data: Record<string, unknown>) =>
    props.frame()?.contentWindow?.postMessage({ ...data, token }, props.runtimeOrigin);

  function positionPopup() {
    const next = calculatePreviewPopoverPosition(
      props.frame()?.getBoundingClientRect(),
      draft().capture,
    );
    if (next) setPosition(next);
  }

  function stop() {
    clearTimeout(readiness);
    setBridgeMode({ kind: "idle" });
    send({ type: "factory-review-select", mode: "" });
  }

  function start() {
    if (reviewData().readOnly) return;
    setPopover(ensurePopoverMounted);
    setBridgeMode({ kind: "connecting" });
    setError("");
    send({
      type: "factory-review-select",
      mode: "element",
      theme: readPreviewTheme(toggle ?? document.body),
    });
    clearTimeout(readiness);
    readiness = setTimeout(() => {
      setError(
        "This App did not enable element selection. You can still add general feedback here.",
      );
      setPopover({ kind: "composer" });
      setBridgeMode({ kind: "idle" });
    }, 3_000);
    props.frame()?.focus();
  }

  function openFeedback(id: string) {
    if (hasPreviewDraft(draft())) {
      setError("Finish or cancel your current feedback first. Your draft is kept.");
      return;
    }
    if (!reviewData().feedback.some((candidate) => candidate.id === id)) return;
    setPopover({ kind: "feedback", feedbackID: id });
    positionPopup();
  }

  function closeFeedback() {
    const id = feedbackID();
    const doc = previewDoc();
    setPopover({ kind: "closed" });
    toggle?.focus({ preventScroll: true });
    if (id && props.active)
      send({
        type: "factory-review-focus-feedback",
        feedbackId: id,
        documentId: doc.kind === "loaded" ? doc.documentID : "",
      });
  }

  createEffect(
    () => Boolean(feedbackID() && popup() && props.active),
    (visible) => {
      if (visible) queueMicrotask(() => feedbackHeading?.focus({ preventScroll: true }));
    },
  );

  function receive(event: MessageEvent) {
    if (
      event.source !== props.frame()?.contentWindow ||
      event.origin !== props.runtimeOrigin ||
      event.data?.token !== token
    )
      return;
    const message = parsePreviewBridgeMessage(event.data);
    if (!message) return;
    if (message.type === "ready") {
      clearTimeout(readiness);
      setPreviewDoc({ kind: "loaded", documentID: message.documentId, page: message.page });
      setBridgeMode({ kind: "selecting" });
    } else if (message.type === "cancel") {
      stop();
      toggle?.focus({ preventScroll: true });
    } else if (message.type === "open-feedback") {
      const doc = previewDoc();
      if (doc.kind === "loaded" && message.documentId === doc.documentID)
        openFeedback(message.feedbackId);
    } else if (message.type === "context-image") {
      setDraft((prev) =>
        attachPreviewContextImage(prev, message.selectionId, message.documentId, message.frame),
      );
    } else if (message.type === "selection") {
      if (!commenting() || !props.active || draft().dirty) return;
      const value = message.payload;
      setPreviewDoc({ kind: "loaded", documentID: value.documentId, page: value.page });
      setDraft((prev) => ({
        ...prev,
        capture: createPreviewCapture(value, props.attemptID),
      }));
      positionPopup();
      setPopover({ kind: "composer" });
    }
  }

  const reload = () => {
    setPreviewDoc({ kind: "unloaded" });
    if (commenting() && props.active) start();
  };
  createEffect(
    () => props.frame(),
    (frame) => {
      frame?.addEventListener("load", reload);
      return () => frame?.removeEventListener("load", reload);
    },
  );
  createEffect(
    () => props.active,
    (active) => {
      if (!active) stop();
    },
  );
  createEffect(
    () => ({ doc: previewDoc(), items: reviewData().feedback, active: commenting() }),
    ({ doc, items, active }) => {
      if (doc.kind !== "loaded") return;
      send({
        type: "factory-review-pins",
        documentId: doc.documentID,
        pins: buildPreviewPins(items, props.attemptID, doc, active),
      });
    },
  );

  const hidden = () => {
    if (document.visibilityState === "hidden") stop();
  };
  window.addEventListener("message", receive);
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("resize", positionPopup);
  onCleanup(() => {
    stop();
    window.removeEventListener("message", receive);
    window.removeEventListener("resize", positionPopup);
    document.removeEventListener("visibilitychange", hidden);
  });

  return (
    <div class={`preview-review ${commenting() ? "is-commenting" : ""}`}>
      <div class="preview-review-toolbar">
        <Show when={props.onOpenTicket}>
          <button type="button" class="quiet-button" onClick={props.onOpenTicket}>
            <Icon name="ticket" />
            Feedback in Ticket
          </button>
        </Show>
        <Show when={!reviewData().readOnly}>
          <button
            ref={toggle}
            type="button"
            class="quiet-button preview-comment-toggle"
            aria-pressed={commenting() ? "true" : "false"}
            onClick={() => {
              if (commenting()) stop();
              else if (hasPreviewDraft(draft())) setPopover({ kind: "composer" });
              else start();
            }}
          >
            <Icon name="comment" />
            {previewToggleLabel(bridgeMode(), draft())}
          </button>
        </Show>
      </div>
      <Show when={commenting() && !popup()}>
        <p class="preview-comment-hint" role="status">
          {previewHintMessage(bridgeMode())}
        </p>
      </Show>
      <Show when={error()}>
        <p class="preview-comment-error" role="status">
          {error()}
        </p>
      </Show>
      <Show when={isPopoverMounted(popover())}>
        <section
          class="preview-comment-popover"
          aria-label="Preview feedback"
          tabindex="-1"
          hidden={!popup()}
          style={{
            "--review-popover-x": `${position().x}px`,
            "--review-popover-y": `${position().y}px`,
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !feedbackID()) return;
            event.preventDefault();
            event.stopPropagation();
            closeFeedback();
          }}
        >
          <Show when={feedbackID()}>
            <header class="preview-feedback-heading">
              <h3 ref={feedbackHeading} tabindex="-1">
                Feedback
              </h3>
              <button
                type="button"
                class="quiet-button icon-button"
                aria-label="Close feedback"
                title="Close feedback"
                onClick={closeFeedback}
              >
                <Icon name="close" />
              </button>
            </header>
          </Show>
          <ReviewPanel
            projectID={props.projectID}
            changeID={props.changeID}
            userID={props.userID}
            canDevelop={props.canDevelop}
            capture={draft().capture}
            feedbackID={feedbackID()}
            active={props.active && popup()}
            compact
            viewID={`${props.attemptID}:${props.frame()?.src ?? "preview"}`}
            onDraftChange={(dirty) => setDraft((prev) => ({ ...prev, dirty }))}
            onFeedback={(items, closed) => {
              setReviewData({ feedback: items, readOnly: closed });
              if (closed) stop();
            }}
            onCaptureCleared={() => {
              setDraft((prev) => ({ ...prev, capture: undefined }));
              setPopover({ kind: "closed" });
              if (commenting() && props.active) start();
            }}
            onClose={() => {
              setPopover({ kind: "closed" });
              stop();
              toggle?.focus({ preventScroll: true });
            }}
          />
        </section>
      </Show>
    </div>
  );
}
