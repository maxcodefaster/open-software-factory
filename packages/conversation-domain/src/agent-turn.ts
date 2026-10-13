import { z } from "zod";
import { interviewAnswerInput } from "./conversation";
import { skillRevisionIDsInput } from "./skills";
import { modelConnectionReference } from "./model-connection";

export const changeAgentStartInput = z.object({ commandId: z.uuid() }).strict();
export const changeAgentResumeInput = changeAgentStartInput
  .extend({ pausedTurnId: z.uuid() })
  .strict();
export const changeAgentStopConfirmationInput = z.object({ stopId: z.uuid() }).strict();
export const changeAgentPromptInput = changeAgentStartInput
  .extend({
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();

const commandFields = {
  commandId: z.uuid(),
  projectId: z.uuid(),
  createdBy: z.uuid(),
};
const projectFields = {
  ...commandFields,
  conversationId: z.uuid(),
  ticketId: z.uuid().nullable(),
};
const changeFields = {
  ...commandFields,
  conversationId: z.uuid().nullable(),
  ticketId: z.uuid(),
  changeId: z.uuid(),
};

export const agentTurnCommandInput = z.discriminatedUnion("kind", [
  z
    .object({
      ...projectFields,
      kind: z.literal("project-message"),
      text: z.string().trim().min(1).max(12_000),
      intent: z.enum(["requirements-interview", "project-research"]).optional(),
    })
    .strict(),
  z
    .object({
      ...projectFields,
      kind: z.literal("project-answer"),
      questionEntryId: z.uuid(),
      answer: interviewAnswerInput,
    })
    .strict(),
  z.object({ ...changeFields, kind: z.literal("change-start") }).strict(),
  z
    .object({
      ...changeFields,
      kind: z.literal("change-prompt"),
      text: z.string().trim().min(1).max(8_000),
    })
    .strict(),
  z
    .object({
      ...changeFields,
      kind: z.literal("change-repair"),
      text: z.string().trim().min(1).max(8_000),
    })
    .strict(),
]);
export type AgentTurnCommand = z.infer<typeof agentTurnCommandInput>;

const projectAuthorityFields = {
  conversationVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  modelId: z.string().trim().min(1).max(200),
  modelConnection: modelConnectionReference.optional(),
  skillRevisionIds: skillRevisionIDsInput.default([]),
};
export const agentTurnAuthorityInput = z.discriminatedUnion("mode", [
  z.object({ ...projectAuthorityFields, mode: z.literal("investigate") }).strict(),
  z.object({ ...projectAuthorityFields, mode: z.literal("plan") }).strict(),
  z
    .object({
      mode: z.literal("build"),
      // Older immutable records may have no version. They remain readable,
      // but cannot authorize a versioned Conversation's execution.
      conversationVersion: projectAuthorityFields.conversationVersion.nullable().default(null),
      requirementRevisionId: z.uuid(),
      modelId: z.string().trim().min(1).max(200),
      modelConnection: modelConnectionReference.optional(),
      skillRevisionIds: skillRevisionIDsInput.default([]),
    })
    .strict(),
]);
export type AgentTurnAuthority = z.infer<typeof agentTurnAuthorityInput>;

export const agentTurnStates = [
  "pending",
  "dispatching",
  "running",
  "completed",
  "failed",
  "stopped",
  "uncertain",
] as const;
export type AgentTurnState = (typeof agentTurnStates)[number];

export function assertAgentTurnAuthority(
  command: AgentTurnCommand,
  authority: z.input<typeof agentTurnAuthorityInput>,
) {
  const projectCommand = command.kind === "project-message" || command.kind === "project-answer";
  if (projectCommand === (authority.mode === "build")) {
    throw new Error("Agent command and authority do not match");
  }
  if (command.kind === "project-answer" && authority.mode !== "plan") {
    throw new Error("Interview answers need Plan authority");
  }
}

export function agentTurnBoundary(command: AgentTurnCommand) {
  return command.ticketId
    ? `agent-turn:${command.projectId}:ticket:${command.ticketId}`
    : `agent-turn:${command.projectId}:draft:${command.createdBy}`;
}
