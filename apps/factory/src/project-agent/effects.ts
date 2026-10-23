import type { ProjectAgentOutput } from "../../../../packages/conversation-domain/src/conversation";
import type { AgentTurnRecord, AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { appendConversationEntry, lockConversation } from "./conversation-store";

export async function persistProjectOutput(
  transaction: AgentTurnTransaction,
  turn: AgentTurnRecord,
  output: ProjectAgentOutput,
  developerOnly = false,
) {
  const { command, authority } = turn;
  if (authority.mode === "build" || !command.conversationId)
    throw new Error("Project turn required");
  const current = await lockConversation(transaction, command.conversationId, command.contextId);
  if (
    !current ||
    current.mode !== authority.mode ||
    current.version !== authority.conversationVersion
  )
    throw new CommandError(
      "conflict",
      "The conversation authority changed before the Agent response",
    );
  if (output.kind === "requirement" && current.mode !== "plan")
    throw new Error("Requirement proposals need Plan mode");
  const [input] = await transaction<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM factory.conversation_entry
    WHERE conversation_id=${current.id} AND payload->>'commandId'=${command.commandId}
    ORDER BY ordinal DESC LIMIT 1`;
  if (output.kind === "epic") {
    if (current.mode !== "plan") throw new Error("Epic proposals require planning authority");
    await appendConversationEntry(transaction, current.id, {
      kind: "requirement",
      actor: "project-agent",
      mode: current.mode,
      body: output.message,
      payload: {
        epicProposal: output.proposal,
        base: input?.payload["ticketContext"] ?? null,
        ...(developerOnly ? { visibility: "developer" } : {}),
      },
      citations: output.citations,
      inReplyToEntryId: null,
      requirementRevisionId: null,
      ...(command.contextId ? { contextId: command.contextId } : {}),
    });
    return;
  }
  if (output.kind === "round") {
    const question = output.questions[0];
    if (!question) throw new Error("An Interview Round needs a question");
    await appendConversationEntry(transaction, current.id, {
      kind: "question",
      actor: "project-agent",
      mode: current.mode,
      body: question.prompt,
      payload: {
        ...(developerOnly ? { visibility: "developer" } : {}),
        message: output.message,
        question,
        roundId: command.commandId,
        roundQuestions: output.questions,
        roundIndex: 0,
      },
      citations: output.citations,
      inReplyToEntryId: null,
      requirementRevisionId: null,
      ...(command.contextId ? { contextId: command.contextId } : {}),
    });
    return;
  }
  // A model response is a proposal, never authority to replace an authored document.
  await appendConversationEntry(transaction, current.id, {
    kind:
      output.kind === "question"
        ? "question"
        : output.kind === "requirement"
          ? "requirement"
          : "agent-message",
    actor: "project-agent",
    mode: current.mode,
    body: output.kind === "question" ? output.question.prompt : output.message,
    payload:
      output.kind === "question"
        ? {
            message: output.message,
            question: output.question,
            ...(developerOnly ? { visibility: "developer" } : {}),
          }
        : output.kind === "requirement"
          ? {
              ticketId: current.ticketId,
              ticket: output.ticket,
              requirement: output.requirement,
              base: input?.payload["ticketContext"] ?? null,
              ...(developerOnly ? { visibility: "developer" } : {}),
            }
          : developerOnly
            ? { visibility: "developer" }
            : {},
    citations: output.citations,
    inReplyToEntryId: null,
    requirementRevisionId: null,
    ...(command.contextId ? { contextId: command.contextId } : {}),
  });
}
