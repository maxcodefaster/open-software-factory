import { z } from "zod";
import {
  conversationMessageInput,
  conversationModeCommandInput,
  newConversationInput,
  interviewAnswerCommandInput,
} from "../../../../packages/conversation-domain/src/conversation";
import { confirmEpicProposalInput } from "../../../../packages/conversation-domain/src/epic-proposal";
import { conversationReadInput } from "../project-agent/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getConversation(
  projectID: string,
  input: z.input<typeof conversationReadInput> = {},
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      command = conversationReadInput.parse(input),
      context = factoryFunctionContext();
    return context.conversations.get(context.actorID, id, command);
  });
}
export async function newProjectConversation(
  projectID: string,
  input: z.input<typeof newConversationInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      command = newConversationInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.conversations.newConversation(context.actorID, id, command);
  });
}
export async function sendConversationMessage(
  projectID: string,
  input: z.input<typeof conversationMessageInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      command = conversationMessageInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.conversations.message(context.actorID, id, command, context.signal);
  });
}
export async function setConversationMode(
  projectID: string,
  input: z.input<typeof conversationModeCommandInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      command = conversationModeCommandInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.conversations.mode(context.actorID, id, command);
  });
}
export async function answerConversationQuestion(
  projectID: string,
  input: z.input<typeof interviewAnswerCommandInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      command = interviewAnswerCommandInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.conversations.answer(context.actorID, id, command);
  });
}
export async function confirmEpicProposal(
  projectID: string,
  entryID: string,
  input: z.input<typeof confirmEpicProposalInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      entry = z.uuid().parse(entryID),
      command = confirmEpicProposalInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.conversations.confirmEpic(context.actorID, id, entry, command);
  });
}
