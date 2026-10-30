import { expect, test } from "bun:test";
import type { AgentMessage } from "./api-contracts";
import {
  activeActivity,
  activityGroupState,
  activityGroupSummary,
  activityStatus,
  groupConversationActivities,
} from "./conversation-activity";
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

test("confirmed Stop leaves unfinished tool output interrupted, never running or successful", () => {
  const command: AgentMessage = {
    ...message("build", 1, "shell"),
    activity: { name: "shell", status: "running" },
  };
  expect(activeActivity(command)).toBe(true);
  expect(activeActivity(command, true)).toBe(false);
  expect(command.activity?.status).toBe("running");
});

test("stopped activity keeps failure and success receipts and distinguishes missing results", () => {
  const activities = ["pending", "streaming", "running", "completed", "error"] as const;
  const messages = activities.map((status, at) => ({
    ...message(status, at, "shell"),
    activity: { name: "shell", status },
  }));
  expect(messages.map((message) => activityStatus(message, true))).toEqual([
    "interrupted",
    "interrupted",
    "interrupted",
    "completed",
    "error",
  ]);
  expect(activityGroupState(messages, false)).toBe("3 active · 1 failed");
  expect(activityGroupState(messages, true)).toBe("3 interrupted · 1 failed");
  expect(activityGroupState([message("complete", 1, "read")], true)).toBe("Completed");
});
