import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { z } from "zod";
import {
  type ReviewFeedback,
  reviewRegion,
} from "../../../../packages/conversation-domain/src/visual-review";
import { Icon } from "../icon";
import { type ReviewCapture, ReviewPanel } from "./panel";

const selectionInput = z.object({
  type: z.literal("factory-review-selection"),
  selectionId: z.uuid(),
  documentId: z.uuid(),
  region: reviewRegion,
  page: z.string().startsWith("/").max(4096),
  element: z.string().max(1000).optional(),
  selector: z.string().max(1000).optional(),
});

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
  const [commenting, setCommenting] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [mounted, setMounted] = createSignal(false);
  const [popup, setPopup] = createSignal(false);
  const [capture, setCapture] = createSignal<ReviewCapture>();
  const [feedbackID, setFeedbackID] = createSignal<string>();
  const [feedback, setFeedback] = createSignal<ReviewFeedback[]>([]);
  const [readOnly, setReadOnly] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [documentID, setDocumentID] = createSignal("");
  const [page, setPage] = createSignal("");
  const [error, setError] = createSignal("");
  const [position, setPosition] = createSignal({ x: 16, y: 64 });
  const token = crypto.randomUUID();
  let toggle: HTMLButtonElement | undefined;
  let feedbackHeading: HTMLHeadingElement | undefined;
  let readiness: ReturnType<typeof setTimeout> | undefined;
  const send = (data: Record<string, unknown>) =>
    props.frame()?.contentWindow?.postMessage({ ...data, token }, props.runtimeOrigin);
  function stop() {
    clearTimeout(readiness);
    setCommenting(false);
    setReady(false);
    send({ type: "factory-review-select", mode: "" });
  }
  function start() {
    if (readOnly()) return;
    setMounted(true);
    setCommenting(true);
    setReady(false);
    setError("");
    const style = getComputedStyle(toggle ?? document.body);
    send({
      type: "factory-review-select",
      mode: "element",
      theme: {
        accent: style.getPropertyValue("--color-river-deep").trim(),
        foreground: style.getPropertyValue("--color-ink-inverse").trim(),
        fontFamily: style.getPropertyValue("--font-interface").trim(),
        fontSize: style.getPropertyValue("--text-sm").trim(),
      },
    });
    clearTimeout(readiness);
    readiness = setTimeout(() => {
      setError(
        "This App did not enable element selection. You can still add general feedback here.",
      );
      setPopup(true);
      setCommenting(false);
    }, 3_000);
    props.frame()?.focus();
  }
  const selection = () => {
    const current = capture();
    return current?.region ? { x: current.region.x, y: current.region.y } : { x: 0.5, y: 0.2 };
  };
  function positionPopup() {
    const rect = props.frame()?.getBoundingClientRect();
    if (!rect) return;
    const point = selection();
    const x = rect.width * point.x;
    const y = rect.height * point.y;
    setPosition({
      x: Math.max(12, Math.min(rect.width - 336, x + 330 < rect.width ? x + 14 : x - 330)),
      y: Math.max(12, Math.min(Math.max(12, rect.height - 310), y + 18)),
    });
  }
  function openFeedback(id: string) {
    if (dirty() || capture()) {
      setError("Finish or cancel your current feedback first. Your draft is kept.");
      return;
    }
    const item = feedback().find((candidate) => candidate.id === id);
    if (!item) return;
    setFeedbackID(id);
    setPopup(true);
    setMounted(true);
    positionPopup();
  }
  function closeFeedback() {
    const id = feedbackID();
    setPopup(false);
    setFeedbackID(undefined);
    toggle?.focus({ preventScroll: true });
    if (id && props.active)
      send({ type: "factory-review-focus-feedback", feedbackId: id, documentId: documentID() });
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
    if (event.data.type === "factory-review-ready") {
      const input = z
        .object({ documentId: z.uuid(), page: z.string().startsWith("/").max(4096) })
        .safeParse(event.data);
      if (!input.success) return;
      clearTimeout(readiness);
      setDocumentID(input.data.documentId);
      setPage(input.data.page);
      setReady(true);
      return;
    }
    if (event.data.type === "factory-review-cancel") {
      stop();
      toggle?.focus({ preventScroll: true });
      return;
    }
    if (event.data.type === "factory-review-open-feedback") {
      if (event.data.documentId === documentID() && typeof event.data.feedbackId === "string")
        openFeedback(event.data.feedbackId);
      return;
    }
    if (event.data.type === "factory-review-context-image") {
      const current = capture();
      if (
        !current ||
        current.id !== event.data.selectionId ||
        current.documentId !== event.data.documentId
      )
        return;
      const image: unknown = event.data.image;
      if (
        typeof image !== "string" ||
        image.length > 2_800_000 ||
        !image.startsWith("data:image/jpeg;base64,")
      )
        return;
      try {
        const data = Uint8Array.from(atob(image.slice(image.indexOf(",") + 1)), (value) =>
          value.charCodeAt(0),
        );
        if (data.byteLength > 2_097_152) return;
        setCapture((value) =>
          value && value.id === current.id
            ? { ...value, frame: new Blob([data], { type: "image/jpeg" }) }
            : value,
        );
      } catch {
        /* The optional context image never blocks feedback. */
      }
      return;
    }
    if (!commenting() || !props.active) return;
    const input = selectionInput.safeParse(event.data);
    if (!input.success || dirty()) return;
    const value = input.data;
    setDocumentID(value.documentId);
    setPage(value.page);
    setFeedbackID(undefined);
    setCapture({
      id: value.selectionId,
      context: {
        source: "preview",
        attemptId: props.attemptID,
        representation: "dom-reconstruction",
      },
      page: value.page,
      documentId: value.documentId,
      region: value.region,
      ...(value.selector ? { selector: value.selector } : {}),
      ...(value.element ? { element: value.element } : {}),
    });
    positionPopup();
    setPopup(true);
  }
  window.addEventListener("message", receive);
  const reload = () => {
    setDocumentID("");
    setPage("");
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
    () => ({ id: documentID(), items: feedback(), active: commenting(), page: page() }),
    (current) => {
      if (!current.id) return;
      send({
        type: "factory-review-pins",
        documentId: current.id,
        pins: current.active
          ? current.items.flatMap((item, index) => {
              const annotation = item.annotation;
              return annotation?.source === "preview" &&
                annotation.attemptId === props.attemptID &&
                annotation.documentId === current.id &&
                annotation.page === current.page &&
                annotation.selector
                ? [
                    {
                      id: item.id,
                      selector: annotation.selector,
                      label: String(index + 1),
                      element: annotation.element ?? "",
                    },
                  ]
                : [];
            })
          : [],
      });
    },
  );
  const hidden = () => {
    if (document.visibilityState === "hidden") stop();
  };
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
        <Show when={!readOnly()}>
          <button
            ref={toggle}
            type="button"
            class="quiet-button preview-comment-toggle"
            aria-pressed={commenting() ? "true" : "false"}
            onClick={() => {
              if (commenting()) stop();
              else if (capture() || dirty()) setPopup(true);
              else start();
            }}
          >
            <Icon name="comment" />
            {commenting()
              ? "Done commenting"
              : capture() || dirty()
                ? "Continue feedback"
                : "Comment"}
          </button>
        </Show>
      </div>
      <Show when={commenting() && !popup()}>
        <p class="preview-comment-hint" role="status">
          {ready()
            ? "Hover an element and click. Tab and Enter also work. Esc exits."
            : "Opening comment mode…"}
        </p>
      </Show>
      <Show when={error()}>
        <p class="preview-comment-error" role="status">
          {error()}
        </p>
      </Show>
      <Show when={mounted()}>
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
            capture={capture()}
            feedbackID={feedbackID()}
            active={props.active && popup()}
            compact
            viewID={`${props.attemptID}:${props.frame()?.src ?? "preview"}`}
            onDraftChange={setDirty}
            onFeedback={(items, closed) => {
              setFeedback(items);
              setReadOnly(closed);
              if (closed) stop();
            }}
            onCaptureCleared={() => {
              setCapture(undefined);
              setPopup(false);
              if (commenting() && props.active) start();
            }}
            onClose={() => {
              setPopup(false);
              stop();
              toggle?.focus({ preventScroll: true });
            }}
          />
        </section>
      </Show>
    </div>
  );
}
