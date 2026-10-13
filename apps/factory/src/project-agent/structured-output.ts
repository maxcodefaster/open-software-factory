import { z } from "zod";
import {
  type ConversationMode,
  projectAgentAnswerOutput,
  projectAgentOutput,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";

const fields = sourceCitationInput.shape;
const projectCitation = z
  .object({
    source: z.enum(["knowledge", "ticket", "epic"]),
    id: fields.id,
    label: fields.label,
    reference: fields.reference.unwrap().nullable().default(null),
  })
  .strict();
const citation = z.discriminatedUnion("source", [
  projectCitation,
  projectCitation.extend({
    source: z.literal("code"),
    commitSha: fields.commitSha.unwrap(),
    path: fields.path.unwrap(),
  }),
]);
const citations = z.array(citation).max(12).default([]);
const [answer, question, round, requirement, epic] = projectAgentOutput.options;
const planning = z.discriminatedUnion("kind", [
  answer.extend({ citations }),
  question.extend({ citations }),
  round.extend({ citations }),
  requirement.extend({ citations }),
  epic.extend({ citations }),
]);

// Strict provider schemas require every property. Non-applicable Git fields must
// be absent from non-code variants, and an unused footnote is explicitly null.
export function projectAgentProviderOutputFor(mode: ConversationMode) {
  return z
    .object({
      output: mode === "investigate" ? projectAgentAnswerOutput.extend({ citations }) : planning,
    })
    .strict();
}

export function parseProjectAgentOutput(value: unknown, mode: ConversationMode) {
  const { output } = projectAgentProviderOutputFor(mode).parse(value);
  return projectAgentOutput.parse({
    ...output,
    citations: output.citations.map(({ reference, ...source }) => ({
      ...source,
      ...(reference === null ? {} : { reference }),
    })),
  });
}

export class ProjectAgentOutputError extends Error {
  constructor() {
    super("The Project Agent returned an invalid response. Your input is saved.");
    this.name = "ProjectAgentOutputError";
  }
}

export function isStructuredOutputFailure(cause: unknown) {
  if (cause instanceof z.ZodError) return true;
  const parsed = z.object({ id: z.string() }).safeParse(cause);
  return (
    parsed.success &&
    [
      "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
      "STRUCTURED_OUTPUT_OBJECT_UNDEFINED",
      "STRUCTURED_OUTPUT_TRUNCATED",
    ].includes(parsed.data.id)
  );
}
