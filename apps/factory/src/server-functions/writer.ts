import { z } from "zod";
import type {
  editingCommand,
  writerActivityCommand,
  writerTakeoverCommand,
} from "../access/writer-command";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getChangeWriterStatus(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    return context.writer.status(context.actorID, change);
  });
}
export async function observeChangeWriter(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    return context.writer.observe(context.actorID, change);
  });
}
export async function takeOverChangeEditing(
  changeID: string,
  input: z.input<typeof writerTakeoverCommand>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.writer.takeOver(context.actorID, change, input);
  });
}
export async function requestChangeEditing(
  changeID: string,
  input: z.input<typeof editingCommand>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.writer.request(context.actorID, change, input);
  });
}
export async function approveChangeEditing(
  changeID: string,
  input: z.input<typeof editingCommand>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.writer.approve(context.actorID, change, input);
  });
}
export async function releaseChangeEditing(
  changeID: string,
  input: z.input<typeof editingCommand>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.writer.release(context.actorID, change, input);
  });
}
export async function takeOverIdleEditing(changeID: string, input: z.input<typeof editingCommand>) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.writer.takeIdle(context.actorID, change, input);
  });
}
export async function recordChangeEditingActivity(
  changeID: string,
  input: z.input<typeof writerActivityCommand>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.writer.activity(context.actorID, change, input);
  });
}
