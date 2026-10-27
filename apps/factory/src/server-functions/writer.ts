import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import type {
  editingCommand,
  writerActivityCommand,
  writerTakeoverCommand,
} from "../access/writer-command";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getChangeWriterStatus = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      return context.writer.status(context.actorID, change);
    });
  });
export const observeChangeWriter = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      return context.writer.observe(context.actorID, change);
    });
  });
export const takeOverChangeEditing = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof writerTakeoverCommand>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.writer.takeOver(context.actorID, change, input);
    });
  });
export const requestChangeEditing = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof editingCommand>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.writer.request(context.actorID, change, input);
    });
  });
export const approveChangeEditing = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof editingCommand>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.writer.approve(context.actorID, change, input);
    });
  });
export const releaseChangeEditing = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof editingCommand>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.writer.release(context.actorID, change, input);
    });
  });
export const takeOverIdleEditing = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof editingCommand>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.writer.takeIdle(context.actorID, change, input);
    });
  });
export const recordChangeEditingActivity = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof writerActivityCommand>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.writer.activity(context.actorID, change, input);
    });
  });
