import { z } from "zod";
import {
  type ConversationMode,
  type InterviewQuestion,
  projectAgentAnswerOutput,
  projectAgentOutput,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";

const fields = sourceCitationInput.shape;
const projectCitation = z
  .object({
    source: z.enum(["knowledge", "ticket", "epic", "attachment"]),
    id: fields.id.describe(
      "Copy the exact UUID from the admitted Project source or returned code citation. Never use a path, URL or commit.",
    ),
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
const [answer, question, round, requirement, epic, technicalDesign] = projectAgentOutput.options;
const planning = z.discriminatedUnion("kind", [
  answer.extend({ citations }),
  question.extend({ citations }),
  round.extend({ citations }),
  requirement.extend({ citations }),
  epic.extend({ citations }),
]);
const interview = z.discriminatedUnion("kind", [
  question.extend({ citations }),
  round.extend({ citations }),
  requirement.extend({ citations }),
]);
const automaticInput = z.discriminatedUnion("kind", [
  answer.extend({ citations }),
  requirement.extend({ citations }),
]);
const technical = z.discriminatedUnion("kind", [
  answer.extend({ citations }),
  question.extend({ citations }),
  round.extend({ citations }),
  technicalDesign.extend({ citations }),
]);

// Strict provider schemas require every property. Non-applicable Git fields must
// be absent from non-code variants, and an unused footnote is explicitly null.
export function projectAgentProviderOutputFor(
  mode: ConversationMode,
  requirementsInterview = false,
  inputTask = false,
  technicalPlanning = false,
) {
  return z
    .object({
      output:
        mode === "investigate"
          ? projectAgentAnswerOutput.extend({ citations })
          : technicalPlanning
            ? technical
            : inputTask
              ? automaticInput
              : requirementsInterview
                ? interview
                : planning,
    })
    .strict();
}

export function parseProjectAgentOutput(
  value: unknown,
  mode: ConversationMode,
  technicalPlanning = false,
  requirementsInterview = false,
) {
  const { output } = projectAgentProviderOutputFor(
    mode,
    requirementsInterview,
    false,
    technicalPlanning,
  ).parse(value);
  // The Agent proposes choices, but cannot remove the human's own answer path.
  // Keep this at model admission, not in the generic question/answer contract.
  const withCustomAnswer = (question: InterviewQuestion): InterviewQuestion =>
    question.type === "free-text" ? question : { ...question, allowCustom: true };
  return projectAgentOutput.parse({
    ...output,
    ...(output.kind === "question" ? { question: withCustomAnswer(output.question) } : {}),
    ...(output.kind === "round" ? { questions: output.questions.map(withCustomAnswer) } : {}),
    citations: output.citations.map(({ reference, ...source }) => ({
      ...source,
      ...(reference === null ? {} : { reference }),
    })),
  });
}

export class ProjectAgentOutputError extends Error {
  readonly diagnostic: string;
  constructor(cause?: unknown, schema?: z.ZodType) {
    super("The Project Agent returned an invalid response. Your input is saved.");
    this.name = "ProjectAgentOutputError";
    let current = cause;
    let diagnostic = "Structured output validation failed.";
    let validationError: z.ZodError | undefined;
    let nativeValue: string | undefined;
    for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
      if (current instanceof z.ZodError) {
        validationError = current;
        break;
      }
      const value = current as Record<string, unknown>;
      if (typeof value["id"] === "string" && /^[A-Z_]+$/.test(value["id"]))
        diagnostic = value["id"];
      if (schema && value["id"] === "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED") {
        const details = z.object({ value: z.string() }).safeParse(value["details"]);
        // This is a diagnostic read bound, not a new output/admission limit.
        // Never retain the generated SDK value, even when local validation passes.
        if (details.success && Buffer.byteLength(details.data.value) <= 256 * 1024)
          nativeValue ??= details.data.value;
      }
      current = value["cause"];
    }
    if (!validationError && schema && nativeValue) {
      try {
        const result = schema.safeParse(JSON.parse(nativeValue));
        if (!result.success) validationError = result.error;
      } catch {
        // Malformed diagnostic data cannot repair or publish a rejected response.
      }
    }
    if (validationError)
      diagnostic = validationError.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
        .join("; ");
    // Paths/codes only. Never retain provider request bodies, generated text,
    // credentials or raw SDK error details in a public-facing error.
    this.diagnostic = diagnostic.length > 1024 ? `${diagnostic.slice(0, 1021)}...` : diagnostic;
  }
  get retainedMessage() {
    return `${this.message} Validation: ${this.diagnostic}`;
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
