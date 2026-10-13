import { z } from "zod";
import { requirementContentInput } from "../../requirement-domain/src/content";
import { epicProposalInput } from "./epic-proposal";

export const conversationModes = ["investigate", "plan", "build"] as const;
export const conversationModeInput = z.enum(conversationModes);
export type ConversationMode = z.infer<typeof conversationModeInput>;

export const sourceCitationInput = z
  .object({
    source: z.enum(["knowledge", "ticket", "epic", "code"]),
    id: z.uuid(),
    label: z.string().trim().min(1).max(200),
    reference: z.number().int().min(1).max(12).optional(),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/)
      .optional(),
    path: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .refine((value) => value.source !== "code" || (!!value.commitSha && !!value.path), {
    message: "Code citations require an exact commit and path",
  });

const questionOptionInput = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().max(320).default(""),
  })
  .strict();

const choiceQuestionFields = {
  prompt: z.string().trim().min(1).max(1_000),
  options: z.array(questionOptionInput).min(2).max(8),
  allowCustom: z.boolean().default(true),
};

export const interviewQuestionInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single-select"), ...choiceQuestionFields }).strict(),
  z.object({ type: z.literal("multi-select"), ...choiceQuestionFields }).strict(),
  z
    .object({
      type: z.literal("free-text"),
      prompt: z.string().trim().min(1).max(1_000),
      placeholder: z.string().trim().max(200).default("Write your answer"),
    })
    .strict(),
]);
export type InterviewQuestion = z.infer<typeof interviewQuestionInput>;

export const interviewAnswerInput = z
  .object({
    selectedOptionIds: z.array(z.string()).max(8).default([]),
    customText: z.string().trim().max(4_000).default(""),
  })
  .strict();
export type InterviewAnswer = z.infer<typeof interviewAnswerInput>;

export const conversationMessageInput = z
  .object({
    commandId: z.uuid(),
    ticketId: z.uuid().optional(),
    text: z.string().trim().min(1).max(12_000),
    intent: z.enum(["requirements-interview", "project-research"]).optional(),
  })
  .strict()
  .refine((value) => value.intent !== "requirements-interview" || !!value.ticketId, {
    message: "An Interview requires a Ticket",
  });

export const conversationModeCommandInput = z
  .object({
    ticketId: z.uuid().optional(),
    mode: conversationModeInput,
  })
  .strict();

export const interviewAnswerCommandInput = z
  .object({
    commandId: z.uuid(),
    ticketId: z.uuid().optional(),
    questionEntryId: z.uuid(),
    answer: interviewAnswerInput,
  })
  .strict();

export const projectAgentAnswerOutput = z
  .object({
    kind: z.literal("answer"),
    message: z.string().trim().min(1).max(12_000),
    citations: z.array(sourceCitationInput).max(12).default([]),
  })
  .strict();

const questionOutput = z
  .object({
    kind: z.literal("question"),
    message: z.string().trim().max(2_000).default(""),
    question: interviewQuestionInput,
    citations: z.array(sourceCitationInput).max(12).default([]),
  })
  .strict();

const roundOutput = z
  .object({
    kind: z.literal("round"),
    message: z.string().trim().max(2_000).default(""),
    questions: z.array(interviewQuestionInput).min(1).max(4),
    citations: z.array(sourceCitationInput).max(12).default([]),
  })
  .strict();

const requirementOutput = z
  .object({
    kind: z.literal("requirement"),
    message: z.string().trim().min(1).max(2_000),
    ticket: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(10_000).default(""),
      })
      .strict(),
    requirement: requirementContentInput,
    citations: z.array(sourceCitationInput).max(12).default([]),
  })
  .strict();

export const projectAgentOutput = z.discriminatedUnion("kind", [
  projectAgentAnswerOutput,
  questionOutput,
  roundOutput,
  requirementOutput,
  z
    .object({
      kind: z.literal("epic"),
      message: z.string().trim().min(1).max(2000),
      proposal: epicProposalInput,
      citations: z.array(sourceCitationInput).max(12).default([]),
    })
    .strict(),
]);
export type ProjectAgentOutput = z.infer<typeof projectAgentOutput>;

export function assertModeAuthority(input: {
  nextMode: ConversationMode;
  ticketId?: string | null;
  latestRequirementId?: string | null;
  approvedRequirementId?: string | null;
}) {
  if (input.nextMode !== "build") return;
  if (!input.ticketId) throw new Error("Build requires a Ticket");
  if (!input.latestRequirementId || input.approvedRequirementId !== input.latestRequirementId) {
    throw new Error("Build requires approval of the latest Requirement Revision");
  }
}

export function normalizeInterviewAnswer(question: InterviewQuestion, value: InterviewAnswer) {
  const answer = interviewAnswerInput.parse(value);
  const selected = [...new Set(answer.selectedOptionIds)];
  if (question.type === "free-text") {
    if (selected.length) throw new Error("A free-text question has no selectable options");
    if (!answer.customText) throw new Error("An answer is required");
    return { selectedOptionIds: [], customText: answer.customText, labels: [answer.customText] };
  }
  const options = new Map(question.options.map((option) => [option.id, option.label]));
  if (selected.some((id) => !options.has(id)))
    throw new Error("The answer contains an unknown option");
  if (question.type === "single-select" && selected.length > 1) {
    throw new Error("Choose one option");
  }
  if (answer.customText && !question.allowCustom) throw new Error("A custom answer is not allowed");
  if (question.type === "single-select" && answer.customText && selected.length) {
    throw new Error("Choose an option or write a custom answer");
  }
  if (!selected.length && !answer.customText) throw new Error("An answer is required");
  return {
    selectedOptionIds: selected,
    customText: answer.customText,
    labels: [
      ...selected.map((id) => options.get(id) ?? id),
      ...(answer.customText ? [answer.customText] : []),
    ],
  };
}
