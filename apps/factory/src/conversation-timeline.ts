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
  TMessage extends { id: string; at: number },
>(entries: TEntry[], messages: TMessage[]): ConversationTimelineItem<TEntry, TMessage>[] {
  const questions = new Set(
    entries.filter((entry) => entry.kind === "question").map((entry) => entry.id),
  );
  const timeline: ConversationTimelineItem<TEntry, TMessage>[] = [
    ...entries
      .filter(
        (entry) =>
          entry.kind !== "mode-change" &&
          !(
            entry.kind === "question" &&
            !entries.some(
              (answer) => answer.kind === "answer" && answer.inReplyToEntryId === entry.id,
            ) &&
            entries.some(
              (newer) =>
                newer.ordinal > entry.ordinal &&
                supersedesClarification({ ...newer, kind: newer.kind ?? "" }),
            )
          ) &&
          !(
            entry.kind === "answer" &&
            entry.inReplyToEntryId &&
            questions.has(entry.inReplyToEntryId)
          ) &&
          !(
            entry.kind === "user-message" && entry.payload?.["intent"] === "requirements-interview"
          ),
      )
      .map((entry) => ({
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
