import type { z } from "zod";
import type {
  changeAgentStartInput,
  changeAgentResumeInput,
  changeAgentPromptInput,
  changeAgentStopConfirmationInput,
} from "../../../../packages/conversation-domain/src/agent-turn";
import type { createAccessController } from "../access/controller";
import { agentViewSchema } from "../api-contracts";
import type { createAgentController } from "./controller";
import { navigationMessages } from "./message-projection";
import type { newCodingConversationInput } from "./commands";
import { agentActivityStream } from "./activity-stream";

export function createAgentService(options: {
  access: Pick<
    ReturnType<typeof createAccessController>,
    "requireChange" | "canDevelop" | "requireDevelopment"
  >;
  controller: Pick<
    ReturnType<typeof createAgentController>,
    | "get"
    | "start"
    | "resume"
    | "stop"
    | "recheckStop"
    | "newConversation"
    | "prompt"
    | "subscribeActivity"
  >;
}) {
  const { access, controller } = options;
  async function navigation(
    userID: string,
    changeID: string,
    value: Awaited<ReturnType<typeof controller.get>>,
  ) {
    const projectID = await access.requireChange(userID, changeID);
    const developer = await access.canDevelop(userID, projectID);
    return agentViewSchema.parse({
      ...value,
      messages: navigationMessages(value.messages, developer),
    });
  }
  async function get(userID: string, changeID: string, history = true) {
    await access.requireChange(userID, changeID);
    return navigation(userID, changeID, await controller.get(changeID, undefined, history, true));
  }
  return {
    get,
    async activity(
      userID: string,
      changeID: string,
      signal: AbortSignal,
      currentSession: () => Promise<void>,
    ) {
      await currentSession();
      await access.requireChange(userID, changeID);
      return agentActivityStream({
        signal,
        authorize: async () => {
          await currentSession();
          await access.requireChange(userID, changeID);
        },
        read: () => get(userID, changeID),
        subscribe: async (notify) => controller.subscribeActivity(changeID, notify),
      });
    },
    async start(userID: string, changeID: string, input: z.output<typeof changeAgentStartInput>) {
      const projectID = await access.requireChange(userID, changeID);
      await access.requireDevelopment(userID, projectID);
      return navigation(
        userID,
        changeID,
        await controller.start(
          changeID,
          userID,
          input.commandId,
          input.codingReasoning,
          input.contextId,
        ),
      );
    },
    async resume(userID: string, changeID: string, input: z.output<typeof changeAgentResumeInput>) {
      await access.requireChange(userID, changeID);
      return navigation(
        userID,
        changeID,
        await controller.resume(changeID, userID, input.commandId, input.pausedTurnId),
      );
    },
    async stop(userID: string, changeID: string) {
      await access.requireChange(userID, changeID);
      return navigation(userID, changeID, await controller.stop(changeID));
    },
    async checkStop(
      userID: string,
      changeID: string,
      input: z.output<typeof changeAgentStopConfirmationInput>,
    ) {
      await access.requireChange(userID, changeID);
      return navigation(userID, changeID, await controller.recheckStop(changeID, input.stopId));
    },
    async newConversation(
      userID: string,
      changeID: string,
      input: z.output<typeof newCodingConversationInput>,
    ) {
      await access.requireChange(userID, changeID);
      return {
        contextId: await controller.newConversation(
          changeID,
          userID,
          input.commandId,
          input.contextId,
        ),
      };
    },
    async prompt(userID: string, changeID: string, input: z.output<typeof changeAgentPromptInput>) {
      const projectID = await access.requireChange(userID, changeID);
      await access.requireDevelopment(userID, projectID);
      return navigation(
        userID,
        changeID,
        await controller.prompt(
          changeID,
          input.text,
          userID,
          input.commandId,
          false,
          input.contextId,
        ),
      );
    },
    async requestChanges(
      userID: string,
      changeID: string,
      input: z.output<typeof changeAgentPromptInput>,
    ) {
      await access.requireChange(userID, changeID);
      return navigation(
        userID,
        changeID,
        await controller.prompt(
          changeID,
          input.text,
          userID,
          input.commandId,
          false,
          input.contextId,
        ),
      );
    },
  };
}
