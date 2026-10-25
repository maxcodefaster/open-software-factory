import { z } from "zod";
import {
  changeAgentStartInput,
  changeAgentResumeInput,
  changeAgentPromptInput,
  changeAgentStopConfirmationInput,
} from "../../../../packages/conversation-domain/src/agent-turn";
import { newCodingConversationInput } from "../agent/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getAgentView(changeID: string, history = true) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      includeHistory = z.boolean().parse(history),
      context = factoryFunctionContext();
    return context.agent.get(context.actorID, id, includeHistory);
  });
}
export async function getAgentActivity(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    return context.agent.activity(context.actorID, id, context.signal, context.assertSession);
  });
}
export async function startCoding(changeID: string, input: z.input<typeof changeAgentStartInput>) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      command = changeAgentStartInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.agent.start(context.actorID, id, command);
  });
}
export async function resumeCoding(
  changeID: string,
  input: z.input<typeof changeAgentResumeInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      command = changeAgentResumeInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.agent.resume(context.actorID, id, command);
  });
}
export async function stopCoding(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.agent.stop(context.actorID, id);
  });
}
export async function checkCodingStop(
  changeID: string,
  input: z.input<typeof changeAgentStopConfirmationInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      command = changeAgentStopConfirmationInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.agent.checkStop(context.actorID, id, command);
  });
}
export async function newCodingConversation(
  changeID: string,
  input: z.input<typeof newCodingConversationInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      command = newCodingConversationInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.agent.newConversation(context.actorID, id, command);
  });
}
export async function sendCodingPrompt(
  changeID: string,
  input: z.input<typeof changeAgentPromptInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      command = changeAgentPromptInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.agent.prompt(context.actorID, id, command);
  });
}
export async function requestCodingChanges(
  changeID: string,
  input: z.input<typeof changeAgentPromptInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      command = changeAgentPromptInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.agent.requestChanges(context.actorID, id, command);
  });
}
