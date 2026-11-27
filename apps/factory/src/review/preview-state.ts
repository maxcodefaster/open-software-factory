import { z } from "zod";
import { type ReviewFeedback, reviewRegion } from "#conversation-domain/visual-review";
import type { PanelReviewCapture } from "./panel-state";

export type PreviewBridgeMode = { kind: "idle" } | { kind: "connecting" } | { kind: "selecting" };

export type PreviewPopoverState =
  | { kind: "unmounted" }
  | { kind: "closed" }
  | { kind: "composer" }
  | { kind: "feedback"; feedbackID: string };

export type PreviewDocumentState =
  | { kind: "unloaded" }
  | { kind: "loaded"; documentID: string; page: string };

export type PreviewDraftState = {
  capture: PanelReviewCapture | undefined;
  dirty: boolean;
};

export type PreviewReviewData = {
  feedback: ReviewFeedback[];
  readOnly: boolean;
};

const readyInput = z.object({
  documentId: z.uuid(),
  page: z.string().startsWith("/").max(4096),
});

const selectionInput = z.object({
  type: z.literal("factory-review-selection"),
  selectionId: z.uuid(),
  documentId: z.uuid(),
  region: reviewRegion,
  page: z.string().startsWith("/").max(4096),
  element: z.string().max(1000).optional(),
  selector: z.string().max(1000).optional(),
});

export type PreviewSelectionPayload = z.infer<typeof selectionInput>;

export type PreviewBridgeEvent =
  | { type: "ready"; documentId: string; page: string }
  | { type: "cancel" }
  | { type: "open-feedback"; documentId: string; feedbackId: string }
  | { type: "context-image"; selectionId: string; documentId: string; frame: Blob }
  | { type: "selection"; payload: PreviewSelectionPayload };

export function isPopoverMounted(state: PreviewPopoverState): boolean {
  return state.kind !== "unmounted";
}

export function isPopoverOpen(state: PreviewPopoverState): boolean {
  return state.kind === "composer" || state.kind === "feedback";
}

export function activeFeedbackID(state: PreviewPopoverState): string | undefined {
  return state.kind === "feedback" ? state.feedbackID : undefined;
}

export function ensurePopoverMounted(state: PreviewPopoverState): PreviewPopoverState {
  return state.kind === "unmounted" ? { kind: "closed" } : state;
}

export function hasPreviewDraft(draft: PreviewDraftState): boolean {
  return draft.dirty || Boolean(draft.capture);
}

export function previewToggleLabel(mode: PreviewBridgeMode, draft: PreviewDraftState): string {
  if (mode.kind !== "idle") return "Done commenting";
  return hasPreviewDraft(draft) ? "Continue feedback" : "Comment";
}

export function previewHintMessage(mode: PreviewBridgeMode): string {
  return mode.kind === "selecting"
    ? "Hover an element and click. Tab and Enter also work. Esc exits."
    : "Opening comment mode…";
}

export function readPreviewTheme(element: Element) {
  const style = getComputedStyle(element);
  return {
    accent: style.getPropertyValue("--color-river-deep").trim(),
    foreground: style.getPropertyValue("--color-ink-inverse").trim(),
    fontFamily: style.getPropertyValue("--font-interface").trim(),
    fontSize: style.getPropertyValue("--text-sm").trim(),
  };
}

export function calculatePreviewPopoverPosition(
  rect: DOMRect | undefined,
  capture: PanelReviewCapture | undefined,
): { x: number; y: number } | undefined {
  if (!rect) return undefined;
  const point = capture?.region ? { x: capture.region.x, y: capture.region.y } : { x: 0.5, y: 0.2 };
  const x = rect.width * point.x;
  const y = rect.height * point.y;
  return {
    x: Math.max(12, Math.min(rect.width - 336, x + 330 < rect.width ? x + 14 : x - 330)),
    y: Math.max(12, Math.min(Math.max(12, rect.height - 310), y + 18)),
  };
}

export function createPreviewCapture(
  value: PreviewSelectionPayload,
  attemptID: string,
): PanelReviewCapture {
  return {
    id: value.selectionId,
    context: {
      source: "preview",
      attemptId: attemptID,
      representation: "dom-reconstruction",
    },
    page: value.page,
    documentId: value.documentId,
    region: value.region,
    ...(value.selector ? { selector: value.selector } : {}),
    ...(value.element ? { element: value.element } : {}),
  };
}

export function attachPreviewContextImage(
  draft: PreviewDraftState,
  selectionId: string,
  documentId: string,
  frame: Blob,
): PreviewDraftState {
  const current = draft.capture;
  if (!current || current.id !== selectionId || current.documentId !== documentId) return draft;
  return { ...draft, capture: { ...current, frame } };
}

export function buildPreviewPins(
  items: readonly ReviewFeedback[],
  attemptID: string,
  doc: PreviewDocumentState,
  active: boolean,
) {
  if (doc.kind !== "loaded" || !active) return [];
  return items.flatMap((item, index) => {
    const annotation = item.annotation;
    return annotation?.source === "preview" &&
      annotation.attemptId === attemptID &&
      annotation.documentId === doc.documentID &&
      annotation.page === doc.page &&
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
  });
}

export function parsePreviewBridgeMessage(raw: unknown): PreviewBridgeEvent | null {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return null;
  const data = raw as Record<string, unknown>;
  if (data["type"] === "factory-review-ready") {
    const parsed = readyInput.safeParse(data);
    return parsed.success
      ? { type: "ready", documentId: parsed.data.documentId, page: parsed.data.page }
      : null;
  }
  if (data["type"] === "factory-review-cancel") return { type: "cancel" };
  if (data["type"] === "factory-review-open-feedback") {
    return typeof data["documentId"] === "string" && typeof data["feedbackId"] === "string"
      ? { type: "open-feedback", documentId: data["documentId"], feedbackId: data["feedbackId"] }
      : null;
  }
  if (data["type"] === "factory-review-context-image") {
    const image = data["image"];
    if (
      typeof data["selectionId"] !== "string" ||
      typeof data["documentId"] !== "string" ||
      typeof image !== "string" ||
      image.length > 2_800_000 ||
      !image.startsWith("data:image/jpeg;base64,")
    )
      return null;
    try {
      const bytes = Uint8Array.from(atob(image.slice(image.indexOf(",") + 1)), (value) =>
        value.charCodeAt(0),
      );
      if (bytes.byteLength > 2_097_152) return null;
      return {
        type: "context-image",
        selectionId: data["selectionId"],
        documentId: data["documentId"],
        frame: new Blob([bytes], { type: "image/jpeg" }),
      };
    } catch {
      /* The optional context image never blocks feedback. */
      return null;
    }
  }
  if (data["type"] === "factory-review-selection") {
    const parsed = selectionInput.safeParse(data);
    return parsed.success ? { type: "selection", payload: parsed.data } : null;
  }
  return null;
}
