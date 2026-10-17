type ClarificationEntry = {
  id: string;
  ordinal: number;
  kind: string;
  inReplyToEntryId?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
};

export function supersedesClarification(entry: ClarificationEntry) {
  return (
    entry.kind === "question" ||
    entry.kind === "requirement" ||
    (entry.kind === "user-message" && entry.payload?.["intent"] !== "project-research")
  );
}

export function unansweredClarification<T extends ClarificationEntry>(entries: readonly T[]) {
  const answered = new Set<string>();
  let latestClarification = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (entry.kind === "answer" && entry.inReplyToEntryId) answered.add(entry.inReplyToEntryId);
    if (supersedesClarification(entry))
      latestClarification = Math.max(latestClarification, entry.ordinal);
  }
  return entries.find(
    (entry) =>
      entry.kind === "question" && !answered.has(entry.id) && entry.ordinal >= latestClarification,
  );
}

export function clarificationAction(input: {
  question: boolean;
  working: boolean;
  open: boolean;
  paused: boolean;
  started: boolean;
}) {
  if (input.working) return { label: "Clarification in progress", status: input.open };
  if (input.question)
    return {
      label: input.open && input.paused ? "Clarification paused" : "Continue clarification",
      status: input.open,
    };
  return { label: input.started ? "Clarify further" : "Clarify requirements", status: false };
}
