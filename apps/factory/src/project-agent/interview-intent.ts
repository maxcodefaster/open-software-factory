import type { AgentTurnCommand } from "../../../../packages/conversation-domain/src/agent-turn";
import type { ConversationEntry } from "./conversation-store";

export function isRequirementsInterview(
  command: Extract<AgentTurnCommand, { kind: "project-message" | "project-answer" }>,
  history: readonly ConversationEntry[],
) {
  if (command.kind === "project-message") return command.intent === "requirements-interview";
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
    ? request.payload["intent"] === "requirements-interview"
    : Boolean(command.ticketId);
}
