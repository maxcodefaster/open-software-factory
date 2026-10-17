import { expect, test } from "bun:test";
import { conversationTimeline } from "./conversation-timeline";

test("overlapping snapshots render one item per identity without removing legitimate repeated text", () => {
  const entry = {
    id: "human",
    ordinal: 1,
    kind: "user-message",
    body: "Try again",
    createdAt: "2026-10-16T08:00:00Z",
  };
  const message = { id: "native", at: Date.parse(entry.createdAt) + 1000, text: "Partial answer" };
  const final = { ...message, text: "Completed answer" };
  const items = conversationTimeline(
    [entry, entry, { ...entry, id: "another-command", ordinal: 2 }],
    [message, final],
  );
  expect(items.map((item) => item.id)).toEqual(["human", "another-command", "change-agent:native"]);
  expect(items.at(-1)).toMatchObject({ kind: "change-agent", message: final });
});

test("the visible conversation retains human and agent history without internal mode announcements", () => {
  const entries = [
    { id: "mode", ordinal: 1, kind: "mode-change", createdAt: "2026-10-08T12:00:00Z" },
    { id: "human", ordinal: 2, kind: "user-message", createdAt: "2026-10-08T12:00:01Z" },
    { id: "question", ordinal: 3, kind: "question", createdAt: "2026-10-08T12:00:04Z" },
  ];
  const messages = [
    { id: "seconds", at: Date.parse("2026-10-08T12:00:02Z") / 1_000 },
    { id: "build", at: Date.parse("2026-10-08T12:00:03Z") },
  ];
  expect(conversationTimeline(entries, messages).map((item) => item.id)).toEqual([
    "human",
    "change-agent:seconds",
    "change-agent:build",
    "question",
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

test("long Interview history is scanned a bounded number of times", () => {
  let kindReads = 0;
  const entries = Array.from({ length: 1000 }, (_, index) => {
    const kind = index % 2 ? "answer" : "question";
    return {
      id: `entry-${index}`,
      ordinal: index + 1,
      createdAt: "2026-10-09T08:00:00Z",
      get kind() {
        kindReads++;
        return kind;
      },
      inReplyToEntryId: index % 2 ? `entry-${index - 1}` : null,
    };
  });
  expect(conversationTimeline(entries, [])).toHaveLength(500);
  expect(kindReads).toBeLessThan(entries.length * 12);
});

test("superseding clarification uses ordinals even when input history is unordered", () => {
  const entries = [
    { id: "proposal", kind: "requirement", ordinal: 4, createdAt: "2026-10-09T08:00:00Z" },
    { id: "old", kind: "question", ordinal: 1, createdAt: "2026-10-09T08:00:00Z" },
    {
      id: "research",
      kind: "user-message",
      ordinal: 6,
      payload: { intent: "project-research" },
      createdAt: "2026-10-09T08:00:00Z",
    },
    { id: "current", kind: "question", ordinal: 5, createdAt: "2026-10-09T08:00:00Z" },
  ];
  expect(conversationTimeline(entries, []).map((item) => item.id)).toEqual([
    "proposal",
    "current",
    "research",
  ]);
});
