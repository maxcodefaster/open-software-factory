import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  conversationMessageInput,
  conversationModeCommandInput,
  interviewAnswerCommandInput,
  newConversationInput,
} from "../../../../packages/conversation-domain/src/conversation";
import { confirmEpicProposalInput } from "../../../../packages/conversation-domain/src/epic-proposal";
import { conversationReadInput } from "../project-agent/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getConversation = createServerFn({ method: "POST", strict: { output: false } })
  .validator((args: [projectID: string, input?: z.input<typeof conversationReadInput>]) => args)
  .handler(async ({ data: [projectID, input = {}] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        command = conversationReadInput.parse(input),
        context = factoryFunctionContext();
      return context.conversations.get(context.actorID, id, command);
    });
  });
export const newProjectConversation = createServerFn({ method: "POST", strict: { output: false } })
  .validator((args: [projectID: string, input: z.input<typeof newConversationInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        command = newConversationInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.conversations.newConversation(context.actorID, id, command);
    });
  });
export const sendConversationMessage = createServerFn({ method: "POST", strict: { output: false } })
  .validator((args: [projectID: string, input: z.input<typeof conversationMessageInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        command = conversationMessageInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.conversations.message(context.actorID, id, command, context.signal);
    });
  });
export const setConversationMode = createServerFn({ method: "POST", strict: { output: false } })
  .validator(
    (args: [projectID: string, input: z.input<typeof conversationModeCommandInput>]) => args,
  )
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        command = conversationModeCommandInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.conversations.mode(context.actorID, id, command);
    });
  });
export const answerConversationQuestion = createServerFn({
  method: "POST",
  strict: { output: false },
})
  .validator(
    (args: [projectID: string, input: z.input<typeof interviewAnswerCommandInput>]) => args,
  )
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        command = interviewAnswerCommandInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.conversations.answer(context.actorID, id, command);
    });
  });
export const confirmEpicProposal = createServerFn({ method: "POST" })
  .validator(
    (args: [projectID: string, entryID: string, input: z.input<typeof confirmEpicProposalInput>]) =>
      args,
  )
  .handler(async ({ data: [projectID, entryID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        entry = z.uuid().parse(entryID),
        command = confirmEpicProposalInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.conversations.confirmEpic(context.actorID, id, entry, command);
    });
  });
