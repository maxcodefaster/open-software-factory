import { expect, test } from "bun:test";
import { conversationTimeline } from "./conversation-timeline";

test("the visible conversation retains human and agent history without internal mode announcements", () => {
  const entries = [
    { id: "mode", ordinal: 1, kind: "mode-change", createdAt: "2026-10-08T12:00:00Z" },
    { id: "human", ordinal: 2, kind: "user-message", createdAt: "2026-10-08T12:00:01Z" },
    { id: "question", ordinal: 3, kind: "question", createdAt: "2026-10-08T12:00:02Z" },
  ];
  const messages = [{ id: "build", at: Date.parse("2026-10-08T12:00:03Z") }];
  expect(conversationTimeline(entries, messages).map((item) => item.id)).toEqual([
    "human",
    "question",
    "change-agent:build",
  ]);
  expect(entries).toHaveLength(3);
});
test("Interview actions stay recorded without displaying a synthetic prompt as human chat", () => {
  const entries = [
    {
      id: "start",
      ordinal: 1,
      kind: "user-message",
      body: "Start a requirements interview for this Ticket.",
      payload: { intent: "requirements-interview" },
      createdAt: "2026-10-09T08:00:00Z",
    },
    {
      id: "human",
      ordinal: 2,
      kind: "user-message",
      body: "Start a requirements interview for this Ticket.",
      payload: {},
      createdAt: "2026-10-09T08:00:01Z",
    },
  ];
  expect(conversationTimeline(entries, []).map((item) => item.id)).toEqual(["human"]);
  expect(entries).toHaveLength(2);
});

test("paired Interview answers appear with their question, while an unpaired answer stays visible", () => {
  const entries = [
    { id: "q", kind: "question", ordinal: 1, createdAt: "2026-10-09T08:00:00Z" },
    {
      id: "a",
      kind: "answer",
      inReplyToEntryId: "q",
      ordinal: 2,
      createdAt: "2026-10-09T08:00:01Z",
    },
    {
      id: "unpaired",
      kind: "answer",
      inReplyToEntryId: "missing",
      ordinal: 3,
      createdAt: "2026-10-09T08:00:02Z",
    },
  ];
  expect(conversationTimeline(entries, []).map((item) => item.id)).toEqual(["q", "unpaired"]);
  expect(entries).toHaveLength(3);
});
