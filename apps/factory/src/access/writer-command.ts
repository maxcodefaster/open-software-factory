import { z } from "zod";
import type { createChangeWriterController } from "./writer-controller";

export const editingCommand = z.strictObject({
  commandID: z.uuid(),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestID: z.uuid().optional(),
});
export const writerTakeoverCommand = editingCommand.omit({ requestID: true });
export const writerActivityCommand = z.strictObject({
  epoch: z.number().int().positive(),
  kind: z.enum(["edit", "heartbeat"]),
});

export async function executeEditingCommand(
  writers: Pick<
    ReturnType<typeof createChangeWriterController>,
    "request" | "approve" | "release" | "takeIdle"
  >,
  action: string,
  changeID: string,
  userID: string,
  raw: unknown,
) {
  const input = editingCommand.parse(raw);
  if (action === "request") return writers.request(changeID, userID, input.commandID, input.epoch);
  if (action === "release") return writers.release(changeID, userID, input.commandID, input.epoch);
  if (action === "approve")
    return writers.approve(
      changeID,
      userID,
      input.commandID,
      z.uuid().parse(input.requestID),
      input.epoch,
    );
  return writers.takeIdle(changeID, userID, input.commandID, input.epoch);
}
