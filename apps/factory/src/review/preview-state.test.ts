import { expect, test } from "bun:test";
import {
  activeFeedbackID,
  attachPreviewContextImage,
  buildPreviewPins,
  createPreviewCapture,
  ensurePopoverMounted,
  hasPreviewDraft,
  isPopoverMounted,
  isPopoverOpen,
  parsePreviewBridgeMessage,
  previewHintMessage,
  previewToggleLabel,
} from "./preview-state";

const docId = "11111111-1111-4111-8111-111111111111";
const selectionId = "22222222-2222-4222-8222-222222222222";

test("preview popover and bridge mode helpers derive labels and visibility", () => {
  expect(isPopoverMounted({ kind: "unmounted" })).toBe(false);
  expect(ensurePopoverMounted({ kind: "unmounted" })).toEqual({ kind: "closed" });
  expect(ensurePopoverMounted({ kind: "composer" })).toEqual({ kind: "composer" });
  expect(isPopoverOpen({ kind: "closed" })).toBe(false);
  expect(isPopoverOpen({ kind: "composer" })).toBe(true);
  expect(activeFeedbackID({ kind: "feedback", feedbackID: "fb-1" })).toBe("fb-1");
  expect(activeFeedbackID({ kind: "composer" })).toBeUndefined();

  expect(previewHintMessage({ kind: "connecting" })).toBe("Opening comment mode…");
  expect(previewHintMessage({ kind: "selecting" })).toContain("Hover an element");

  expect(previewToggleLabel({ kind: "idle" }, { capture: undefined, dirty: false })).toBe(
    "Comment",
  );
  expect(previewToggleLabel({ kind: "idle" }, { capture: undefined, dirty: true })).toBe(
    "Continue feedback",
  );
  expect(previewToggleLabel({ kind: "selecting" }, { capture: undefined, dirty: false })).toBe(
    "Done commenting",
  );
});

test("preview bridge message parser validates ready, selection, and context-image payloads", () => {
  expect(
    parsePreviewBridgeMessage({ type: "factory-review-ready", documentId: docId, page: "/app" }),
  ).toEqual({ type: "ready", documentId: docId, page: "/app" });
  expect(
    parsePreviewBridgeMessage({ type: "factory-review-ready", documentId: "bad", page: "/app" }),
  ).toBeNull();
  expect(parsePreviewBridgeMessage({ type: "factory-review-cancel" })).toEqual({ type: "cancel" });

  const selection = parsePreviewBridgeMessage({
    type: "factory-review-selection",
    selectionId,
    documentId: docId,
    page: "/app",
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    element: "Submit button",
    selector: "#submit",
  });
  expect(selection?.type).toBe("selection");
  if (selection?.type !== "selection") throw new Error("expected selection");

  const capture = createPreviewCapture(selection.payload, "attempt-1");
  expect(hasPreviewDraft({ capture, dirty: false })).toBe(true);

  const jpeg = `data:image/jpeg;base64,${btoa("hello")}`;
  const imageMsg = parsePreviewBridgeMessage({
    type: "factory-review-context-image",
    selectionId,
    documentId: docId,
    image: jpeg,
  });
  expect(imageMsg?.type).toBe("context-image");
  if (imageMsg?.type !== "context-image") throw new Error("expected context-image");

  const updated = attachPreviewContextImage(
    { capture, dirty: false },
    selectionId,
    docId,
    imageMsg.frame,
  );
  expect(updated.capture?.frame).toBeInstanceOf(Blob);

  const pins = buildPreviewPins(
    [
      {
        id: "fb-1",
        kind: "thread",
        state: "open",
        authorId: "u1",
        author: "Alex",
        commitSha: "abcdef12",
        createdAt: "2026-01-01T00:00:00.000Z",
        version: 1,
        messages: [],
        annotation: {
          source: "preview",
          attemptId: "attempt-1",
          documentId: docId,
          page: "/app",
          selector: "#submit",
          element: "Submit button",
        },
      },
    ],
    "attempt-1",
    { kind: "loaded", documentID: docId, page: "/app" },
    true,
  );
  expect(pins).toEqual([{ id: "fb-1", selector: "#submit", label: "1", element: "Submit button" }]);
});
