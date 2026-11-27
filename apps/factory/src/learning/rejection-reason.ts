import { LearningResultRejected } from "#conversation-domain/learning";

const semanticPredicates = new Set([
  "Work review must account for every admitted case exactly once",
  "Unknown work review case",
  "Work review cited unobserved evidence",
  "Missing work evidence cannot establish a review verdict",
  "A learning finding needs observed work",
  "An improvement edit must change its declared target",
  "An improvement edit must name an observed exact revision and text",
]);

export function learningRejectionReason(cause: unknown, genericReason: string) {
  if (!(cause instanceof LearningResultRejected)) return genericReason;
  // Exact Factory-owned predicates only. Never copy schema output, prose or nested causes.
  const message = cause.message;
  return semanticPredicates.has(message)
    ? `${genericReason} Diagnostic: ${message}.`
    : genericReason;
}
