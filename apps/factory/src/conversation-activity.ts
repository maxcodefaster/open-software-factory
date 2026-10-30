import type { AgentMessage } from "./api-contracts";
import type { ConversationTimelineItem } from "./conversation-timeline";

export type ConversationDisplayItem<TEntry, TMessage> =
  | ConversationTimelineItem<TEntry, TMessage>
  | {
      kind: "activity-group";
      id: string;
      at: number;
      order: number;
      messages: TMessage[];
    };

/** Group only adjacent calls. Human messages and Assistant prose remain boundaries. */
export function groupConversationActivities<
  TEntry,
  TMessage extends Pick<AgentMessage, "activity">,
>(
  timeline: ConversationTimelineItem<TEntry, TMessage>[],
): ConversationDisplayItem<TEntry, TMessage>[] {
  const result: ConversationDisplayItem<TEntry, TMessage>[] = [];
  let calls: Extract<ConversationTimelineItem<TEntry, TMessage>, { kind: "change-agent" }>[] = [];
  const flush = () => {
    const first = calls[0];
    if (!first) return;
    result.push({
      kind: "activity-group",
      id: `activity-group:${first.id}`,
      at: first.at,
      order: first.order,
      messages: calls.map((item) => item.message),
    });
    calls = [];
  };
  for (const item of timeline) {
    if (item.kind === "change-agent" && item.message.activity) calls.push(item);
    else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

export function activeActivity(message: Pick<AgentMessage, "activity">, stopped = false) {
  return !stopped && ["pending", "streaming", "running"].includes(message.activity?.status ?? "");
}

export function activityStatus(message: Pick<AgentMessage, "activity">, stopped = false) {
  return stopped && activeActivity(message) ? "interrupted" : message.activity?.status;
}

export function activityGroupState(messages: Pick<AgentMessage, "activity">[], stopped = false) {
  const active = messages.filter((message) => activeActivity(message, stopped)).length;
  const interrupted = messages.filter(
    (message) => activityStatus(message, stopped) === "interrupted",
  ).length;
  const failed = messages.filter((message) => message.activity?.status === "error").length;
  return (
    [
      active ? `${active} active` : "",
      interrupted ? `${interrupted} interrupted` : "",
      failed ? `${failed} failed` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Completed"
  );
}

/** Describe observed calls, never infer that a shell command is a successful check. */
export function activityGroupSummary(messages: Pick<AgentMessage, "activity">[]) {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const name = message.activity?.name;
    const category =
      name === "read"
        ? "file read"
        : ["write", "edit", "apply_patch"].includes(name ?? "")
          ? "file change"
          : ["shell", "bash"].includes(name ?? "")
            ? "command"
            : ["grep", "glob", "search"].includes(name ?? "")
              ? "search"
              : "activity";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts]
    .map(([category, count]) => {
      const plural =
        category === "activity"
          ? "activities"
          : category === "search"
            ? "searches"
            : `${category}s`;
      return `${count} ${count === 1 ? category : plural}`;
    })
    .join(" · ");
}
