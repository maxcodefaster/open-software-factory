import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  changeAgentPromptInput,
  changeAgentResumeInput,
  changeAgentStartInput,
  changeAgentStopConfirmationInput,
} from "../../../../packages/conversation-domain/src/agent-turn";
import { newCodingConversationInput } from "../agent/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getAgentView = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, history?: boolean]) => args)
  .handler(async ({ data: [changeID, history = true] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        includeHistory = z.boolean().parse(history),
        context = factoryFunctionContext();
      return context.agent.get(context.actorID, id, includeHistory);
    });
  });
export const getAgentActivity = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      return context.agent.activity(context.actorID, id, context.signal, context.assertSession);
    });
  });
export const startCoding = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof changeAgentStartInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        command = changeAgentStartInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.agent.start(context.actorID, id, command);
    });
  });
export const resumeCoding = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof changeAgentResumeInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        command = changeAgentResumeInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.agent.resume(context.actorID, id, command);
    });
  });
export const stopCoding = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.agent.stop(context.actorID, id);
    });
  });
export const checkCodingStop = createServerFn({ method: "POST" })
  .validator(
    (args: [changeID: string, input: z.input<typeof changeAgentStopConfirmationInput>]) => args,
  )
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        command = changeAgentStopConfirmationInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.agent.checkStop(context.actorID, id, command);
    });
  });
export const newCodingConversation = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof newCodingConversationInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        command = newCodingConversationInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.agent.newConversation(context.actorID, id, command);
    });
  });
export const sendCodingPrompt = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof changeAgentPromptInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        command = changeAgentPromptInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.agent.prompt(context.actorID, id, command);
    });
  });
export const requestCodingChanges = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof changeAgentPromptInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        command = changeAgentPromptInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.agent.requestChanges(context.actorID, id, command);
    });
  });
