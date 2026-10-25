import type { z } from "zod";
import type {
  conversationMessageInput,
  conversationModeCommandInput,
  newConversationInput,
  interviewAnswerCommandInput,
} from "../../../../packages/conversation-domain/src/conversation";
import type { confirmEpicProposalInput } from "../../../../packages/conversation-domain/src/epic-proposal";
import type { createAccessController } from "../access/controller";
import { conversationViewSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import type { createProjectAgentController } from "./controller";
import type { conversationReadInput } from "./commands";
import { projectResponseStream } from "./response-stream";

export function createConversationService(options: {
  access: Pick<ReturnType<typeof createAccessController>, "requireProject">;
  controller: Pick<
    ReturnType<typeof createProjectAgentController>,
    "get" | "newConversation" | "message" | "setMode" | "answer" | "confirmEpic"
  >;
}) {
  const { access, controller } = options;
  const date = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  function dto(value: Awaited<ReturnType<typeof controller.get>>) {
    if (!value) return null;
    return conversationViewSchema.parse({
      ...value,
      contexts: value.contexts.map((context) => ({
        ...context,
        createdAt: date(context["createdAt"]),
      })),
      entries: value.entries.map((entry) => ({ ...entry, createdAt: date(entry["createdAt"]) })),
    });
  }
  function required(value: Awaited<ReturnType<typeof controller.get>>) {
    if (!value)
      throw new CommandError(
        "unavailable",
        "Conversation response is unconfirmed. Refresh its saved history before retrying.",
      );
    return conversationViewSchema.parse(dto(value));
  }
  return {
    async get(userID: string, projectID: string, input: z.output<typeof conversationReadInput>) {
      await access.requireProject(userID, projectID);
      return dto(await controller.get(projectID, input.ticketId, userID, input.contextId));
    },
    async newConversation(
      userID: string,
      projectID: string,
      input: z.output<typeof newConversationInput>,
    ) {
      await access.requireProject(userID, projectID);
      return required(
        await controller.newConversation(projectID, input.ticketId, userID, input.commandId),
      );
    },
    async message(
      userID: string,
      projectID: string,
      input: z.output<typeof conversationMessageInput>,
      signal: AbortSignal,
    ) {
      await access.requireProject(userID, projectID);
      return projectResponseStream(
        async (observer) =>
          required(
            await controller.message(
              projectID,
              input.ticketId,
              input.text,
              userID,
              input.commandId,
              input.intent,
              observer,
              input.contextId,
            ),
          ),
        signal,
      );
    },
    async mode(
      userID: string,
      projectID: string,
      input: z.output<typeof conversationModeCommandInput>,
    ) {
      await access.requireProject(userID, projectID);
      return required(await controller.setMode(projectID, input.ticketId, input.mode, userID));
    },
    async answer(
      userID: string,
      projectID: string,
      input: z.output<typeof interviewAnswerCommandInput>,
    ) {
      await access.requireProject(userID, projectID);
      return required(
        await controller.answer(
          projectID,
          input.ticketId,
          input.questionEntryId,
          input.answer,
          userID,
          input.commandId,
          input.contextId,
        ),
      );
    },
    async confirmEpic(
      userID: string,
      projectID: string,
      entryID: string,
      input: z.output<typeof confirmEpicProposalInput>,
    ) {
      await access.requireProject(userID, projectID);
      return controller.confirmEpic(projectID, entryID, userID, input);
    },
  };
}
