import { expect, test } from "bun:test";
import {
  annotationInput,
  feedbackCreateInput,
  pendingReviewThreads,
  type ReviewFeedback,
} from "./visual-review";

test("Preview feedback retains its anchor without requiring an image", () => {
  const anchor = {
    source: "preview" as const,
    attemptId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    page: "/projects/new",
    selector: "#project-name",
    element: "input Project name",
    region: { x: 0.2, y: 0.3, width: 0.3, height: 0.04 },
  };
  expect(annotationInput.parse(anchor)).toEqual(anchor);
  expect(annotationInput.safeParse({ source: "preview", page: "/projects/new" }).success).toBe(
    false,
  );
  expect(
    annotationInput.safeParse({ ...anchor, region: { x: 0.9, y: 0, width: 0.5, height: 0.1 } })
      .success,
  ).toBe(false);
  expect(annotationInput.safeParse({ ...anchor, selector: "x".repeat(1001) }).success).toBe(false);
});

test("recording feedback still needs an actual frame and timestamp", () => {
  expect(
    annotationInput.safeParse({ source: "recording", page: "/form", timestampMs: 1000 }).success,
  ).toBe(false);
  expect(
    annotationInput.safeParse({ source: "recording", page: "/form", mediaId: crypto.randomUUID() })
      .success,
  ).toBe(false);
  expect(
    annotationInput.parse({
      source: "recording",
      page: "/form",
      mediaId: crypto.randomUUID(),
      timestampMs: 1000,
    }).source,
  ).toBe("recording");
});

test("general feedback has no fabricated image or page context", () => {
  const value = feedbackCreateInput.parse({
    commandId: crypto.randomUUID(),
    kind: "comment",
    body: "The flow is too long.",
  });
  expect(value.annotation).toBeUndefined();
});

test("a revision batch contains only actionable Threads, never notes or repeated rechecks", () => {
  const thread: ReviewFeedback = {
    id: crypto.randomUUID(),
    kind: "thread",
    state: "open",
    version: 1,
    authorId: "author",
    author: "Mara",
    commitSha: "d".repeat(40),
    annotation: null,
    createdAt: new Date().toISOString(),
    messages: [],
  };
  const pending = { ...thread, id: crypto.randomUUID(), correctionState: "pending" as const };
  const retry = { ...thread, id: crypto.randomUUID(), correctionState: "retry" as const };
  expect(
    pendingReviewThreads([
      thread,
      pending,
      retry,
      { ...thread, kind: "comment" },
      { ...thread, state: "resolved" },
      { ...thread, state: "implemented" },
      { ...thread, correctionState: "running" },
      { ...thread, correctionState: "sent" },
    ]),
  ).toEqual([thread, pending, retry]);
});
