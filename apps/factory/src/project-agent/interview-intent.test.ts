import { expect, test } from "bun:test";
import type { AgentTurnCommand } from "../../../../packages/conversation-domain/src/agent-turn";
import type { ConversationEntry } from "./conversation-store";
import { isRequirementsInterview } from "./interview-intent";

const command: Extract<AgentTurnCommand, { kind: "project-answer" }> = {
  kind: "project-answer",
  commandId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  createdBy: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  ticketId: crypto.randomUUID(),
  questionEntryId: crypto.randomUUID(),
  answer: { selectedOptionIds: [], customText: "Keep both follow-ups" },
};
function entry(
  ordinal: number,
  kind: ConversationEntry["kind"],
  payload: Record<string, unknown> = {},
): ConversationEntry {
  return {
    id: kind === "question" ? command.questionEntryId : crypto.randomUUID(),
    ordinal,
    kind,
    actor: kind === "user-message" ? "user" : "project-agent",
    mode: "plan",
    body: "Source text is not task authority",
    payload,
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdAt: new Date(0).toISOString(),
  };
}

test("Project and Ticket planning answers can still propose an Epic", () => {
  for (const ticketId of [null, command.ticketId])
    expect(
      isRequirementsInterview({ ...command, ticketId }, [
        entry(1, "user-message", { intent: "requirements-interview" }),
        entry(2, "user-message"),
        entry(3, "question"),
      ]),
    ).toBe(false);
});

test("research during a paused Ticket interview does not widen the output contract", () => {
  expect(
    isRequirementsInterview(command, [
      entry(1, "user-message", { intent: "requirements-interview" }),
      entry(2, "question"),
      entry(3, "user-message", { intent: "project-research" }),
    ]),
  ).toBe(true);
  expect(
    isRequirementsInterview(command, [
      entry(1, "user-message", { intent: "requirements-interview" }),
      entry(2, "user-message", { intent: "project-research" }),
      entry(3, "answer"),
      entry(4, "question"),
    ]),
  ).toBe(true);
});

test("an explicit new request determines its own task rather than inheriting an old interview", () => {
  const message = {
    kind: "project-message" as const,
    commandId: command.commandId,
    projectId: command.projectId,
    createdBy: command.createdBy,
    conversationId: command.conversationId,
    ticketId: null,
    text: "Plan an Epic",
  };
  const history = [entry(1, "user-message", { intent: "requirements-interview" })];
  expect(isRequirementsInterview(message, history)).toBe(false);
  expect(isRequirementsInterview({ ...message, intent: "requirements-interview" }, history)).toBe(
    true,
  );
});
