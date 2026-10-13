import { describe, expect, test } from "bun:test";
import { conversationTimeline } from "./conversation-timeline";

describe("Ticket Conversation timeline", () => {
  test("keeps Project Agent and Change Agent turns in chronological order", () => {
    const entries = [
      {
        id: "entry-plan",
        ordinal: 1,
        createdAt: "2026-09-16T10:00:00.000Z",
      },
      {
        id: "entry-return",
        ordinal: 2,
        createdAt: "2026-09-16T10:02:00.000Z",
      },
    ];
    const messages = [
      {
        id: "opencode-turn",
        at: Date.parse("2026-09-16T10:01:00.000Z") / 1_000,
      },
    ];

    expect(conversationTimeline(entries, messages).map((item) => item.id)).toEqual([
      "entry-plan",
      "change-agent:opencode-turn",
      "entry-return",
    ]);
  });
});
