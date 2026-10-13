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
  return entries.find(
    (entry) =>
      entry.kind === "question" &&
      !entries.some(
        (later) =>
          (later.kind === "answer" && later.inReplyToEntryId === entry.id) ||
          (later.ordinal > entry.ordinal && supersedesClarification(later)),
      ),
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
