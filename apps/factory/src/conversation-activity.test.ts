import { expect, test } from "bun:test";
import type { AgentMessage } from "./api-contracts";
import { activityGroupSummary, groupConversationActivities } from "./conversation-activity";
import { conversationTimeline } from "./conversation-timeline";

function message(id: string, at: number, name?: string): AgentMessage {
  return {
    id,
    at,
    text: id,
    role: name ? "tool" : "assistant",
    ...(name ? { activity: { name, status: "completed" } } : {}),
  };
}

test("only contiguous calls group; prose and human entries retain their order", () => {
  const timeline = conversationTimeline(
    [{ id: "human", ordinal: 1, createdAt: new Date(4000).toISOString() }],
    [
      message("read-one", 1, "read"),
      message("read-two", 2, "read"),
      message("explanation", 3),
      message("command", 5, "shell"),
    ],
  );
  const grouped = groupConversationActivities(timeline);
  expect(grouped.map((item) => item.kind)).toEqual([
    "activity-group",
    "change-agent",
    "conversation",
    "activity-group",
  ]);
  expect(grouped[0]).toMatchObject({
    id: "activity-group:change-agent:read-one",
    messages: [{ id: "read-one" }, { id: "read-two" }],
  });
});

test("an appended call retains the first call's group identity", () => {
  const first = message("stable", 1, "read");
  const group = (messages: AgentMessage[]) =>
    groupConversationActivities(conversationTimeline([], messages));
  expect(group([first])[0]?.id).toBe(group([first, message("later", 2, "shell")])[0]?.id);
});

test("group summaries report calls rather than claiming tests passed", () => {
  expect(
    activityGroupSummary([
      message("one", 1, "read"),
      message("two", 2, "read"),
      message("three", 3, "shell"),
      message("four", 4, "custom"),
      message("five", 5, "custom"),
    ]),
  ).toBe("2 file reads · 1 command · 2 activities");
  expect(activityGroupSummary([message("one", 1, "search"), message("two", 2, "grep")])).toBe(
    "2 searches",
  );
});
