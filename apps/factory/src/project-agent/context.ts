import type { ConversationEntry } from "./conversation-store";

export const projectContextByteLimit = 96 * 1024;

export class ProjectContextLimitError extends Error {
  constructor() {
    super(
      "This conversation exceeds the Project Agent context limit. Your input is saved; start a focused conversation rather than lose earlier decisions.",
    );
    this.name = "ProjectContextLimitError";
  }
}

// Operational payloads and repeated admission snapshots are not model memory.
// Keep source provenance, authored decisions and proposal content, never a second store.
function content(entry: ConversationEntry) {
  const payload = Object.fromEntries(
    [
      "question",
      "answer",
      "selectedOptionIds",
      "customText",
      "ticket",
      "requirement",
      "epicProposal",
      "accepted",
      "roundId",
      "roundIndex",
    ]
      .filter((key) => entry.payload[key] !== undefined)
      .map((key) => [key, entry.payload[key]]),
  );
  return {
    id: entry.id,
    ordinal: entry.ordinal,
    actor: entry.actor,
    kind: entry.kind,
    body: entry.body,
    payload,
    citations: entry.citations,
    inReplyToEntryId: entry.inReplyToEntryId,
    requirementRevisionId: entry.requirementRevisionId,
  };
}

export function projectModelContext(input: {
  prompt: string;
  history: ConversationEntry[];
  inputEntryId?: string;
}) {
  const ordered = [...input.history].sort((a, b) => a.ordinal - b.ordinal);
  const current = input.inputEntryId
    ? ordered.find((entry) => entry.id === input.inputEntryId)
    : ordered.findLast((entry) => entry.actor === "user" && entry.body === input.prompt);
  const earlier = ordered.filter((entry) => entry.id !== current?.id);
  const decisions = earlier.filter(
    (entry) => entry.actor === "user" || entry.requirementRevisionId,
  );
  const questionIDs = new Set(
    [...decisions, ...(current ? [current] : [])].map((entry) => entry.inReplyToEntryId),
  );
  const pendingQuestion = earlier.findLast((entry) => entry.kind === "question");
  const requirement = earlier.findLast((entry) => entry.payload["requirement"]);
  const epic = earlier.findLast((entry) => entry.payload["epicProposal"]);
  const core = new Set([
    ...decisions.map((entry) => entry.id),
    ...earlier.filter((entry) => questionIDs.has(entry.id)).map((entry) => entry.id),
    ...[pendingQuestion, requirement, epic].flatMap((entry) => (entry ? [entry.id] : [])),
  ]);
  const selected = earlier.filter((entry) => core.has(entry.id));
  const data = {
    frozenProject: current?.payload["projectContext"] ?? null,
    frozenTicket: current?.payload["ticketContext"] ?? null,
    conversation: selected.map(content),
    omittedBackgroundEntries: earlier.length - selected.length,
    currentInput: {
      text: input.prompt,
      ...(current
        ? {
            id: current.id,
            inReplyToEntryId: current.inReplyToEntryId,
            ...(current.kind === "answer"
              ? {
                  answer: {
                    selectedOptionIds: current.payload["selectedOptionIds"] ?? [],
                    hasCustomText: Boolean(current.payload["customText"]),
                  },
                }
              : {}),
          }
        : {}),
    },
  };
  const serialize = () => JSON.stringify(data);
  if (Buffer.byteLength(serialize()) > projectContextByteLimit)
    throw new ProjectContextLimitError();
  // Background assistant prose is expendable. Decisions and their question meanings are not.
  for (const entry of earlier
    .filter((entry) => !core.has(entry.id))
    .slice(-8)
    .reverse()) {
    data.conversation.push(content(entry));
    data.omittedBackgroundEntries--;
    if (Buffer.byteLength(serialize()) > projectContextByteLimit) {
      data.conversation.pop();
      data.omittedBackgroundEntries++;
    }
  }
  data.conversation.sort((a, b) => a.ordinal - b.ordinal);
  return serialize();
}
