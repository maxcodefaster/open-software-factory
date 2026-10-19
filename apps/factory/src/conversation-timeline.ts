import { supersedesClarification } from "../../../packages/conversation-domain/src/clarification";

export type ConversationTimelineItem<TEntry, TMessage> =
  | { kind: "conversation"; id: string; at: number; order: number; entry: TEntry }
  | { kind: "change-agent"; id: string; at: number; order: number; message: TMessage };

export function conversationTimeline<
  TEntry extends {
    id: string;
    ordinal: number;
    createdAt: string;
    kind?: string;
    payload?: Record<string, unknown>;
    inReplyToEntryId?: string | null | undefined;
  },
  TMessage extends { id: string; at: number; commandId?: string | undefined },
>(entries: TEntry[], messages: TMessage[]): ConversationTimelineItem<TEntry, TMessage>[] {
  // Overlapping history pages may repeat identities. Keep the latest snapshot,
  // never deduplicate by text: distinct commands can intentionally say the same thing.
  entries = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
  messages = [...new Map(messages.map((message) => [message.id, message])).values()];
  const questions = new Set(
    entries.filter((entry) => entry.kind === "question").map((entry) => entry.id),
  );
  const answered = new Set<string>();
  let latestClarification = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (entry.kind === "answer" && entry.inReplyToEntryId) answered.add(entry.inReplyToEntryId);
    if (supersedesClarification({ ...entry, kind: entry.kind ?? "" }))
      latestClarification = Math.max(latestClarification, entry.ordinal);
  }
  const displayedEntries = entries.filter(
    (entry) =>
      entry.kind !== "mode-change" &&
      !(
        entry.kind === "question" &&
        !answered.has(entry.id) &&
        latestClarification > entry.ordinal
      ) &&
      !(
        entry.kind === "answer" &&
        entry.inReplyToEntryId &&
        questions.has(entry.inReplyToEntryId)
      ) &&
      !(entry.kind === "user-message" && entry.payload?.["intent"] === "requirements-interview"),
  );
  const journalCommands = new Set(
    displayedEntries.flatMap((entry) =>
      entry.kind === "user-message" && typeof entry.payload?.["commandId"] === "string"
        ? [entry.payload["commandId"]]
        : [],
    ),
  );
  messages = messages.filter(
    (message) => !message.commandId || !journalCommands.has(message.commandId),
  );
  const timeline: ConversationTimelineItem<TEntry, TMessage>[] = [
    ...displayedEntries.map((entry) => ({
      kind: "conversation" as const,
      id: entry.id,
      at: Number.isNaN(Date.parse(entry.createdAt)) ? 0 : Date.parse(entry.createdAt),
      order: entry.ordinal,
      entry,
    })),
    ...messages.map((message, index) => ({
      kind: "change-agent" as const,
      id: `change-agent:${message.id}`,
      at: message.at < 10_000_000_000 ? message.at * 1_000 : message.at,
      order: entries.length + index + 1,
      message,
    })),
  ];
  return timeline.sort((left, right) => left.at - right.at || left.order - right.order);
}
