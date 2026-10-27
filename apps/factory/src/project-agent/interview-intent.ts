import type { AgentTurnCommand } from "../../../../packages/conversation-domain/src/agent-turn";
import type { ConversationEntry } from "./conversation-store";

export function isRequirementsInterview(
  command: Extract<AgentTurnCommand, { kind: "project-message" | "project-answer" }>,
  history: readonly ConversationEntry[],
) {
  if (command.kind === "project-message")
    return command.intent === "requirements-interview" || command.intent === "full-planning";
  const question = history.find((entry) => entry.id === command.questionEntryId);
  // Project planning also uses question controls. Follow the request which
  // produced this question, not the fact that the next command is an answer.
  // Research during a paused interview does not replace its original intent.
  const request = question
    ? history.findLast(
        (entry) =>
          entry.ordinal < question.ordinal &&
          entry.kind === "user-message" &&
          entry.payload["intent"] !== "project-research",
      )
    : undefined;
  return request
    ? ["requirements-interview", "full-planning"].includes(String(request.payload["intent"]))
    : Boolean(command.ticketId);
}

export function planningRequest(
  command: Extract<AgentTurnCommand, { kind: "project-message" | "project-answer" }>,
  history: readonly ConversationEntry[],
) {
  if (command.kind === "project-message")
    return history.find((entry) => entry.payload["commandId"] === command.commandId);
  const question = history.find((entry) => entry.id === command.questionEntryId);
  return question
    ? history.findLast(
        (entry) =>
          entry.ordinal < question.ordinal &&
          entry.kind === "user-message" &&
          entry.payload["intent"] !== "project-research",
      )
    : undefined;
}
