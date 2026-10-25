import { z } from "zod";
import { writerViewSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import type { createAccessController } from "./controller";
import type { createChangeWriterController } from "./writer-controller";
import { editingCommand, writerActivityCommand, writerTakeoverCommand } from "./writer-command";

function confirmed(value: unknown) {
  const result = writerViewSchema.safeParse(value);
  if (!result.success)
    throw new CommandError(
      "unavailable",
      "Editing outcome is unconfirmed. Check its status before retrying.",
    );
  return result.data;
}

export function createWriterService(
  writers: Pick<
    ReturnType<typeof createChangeWriterController>,
    "status" | "view" | "takeOver" | "request" | "approve" | "release" | "takeIdle" | "activity"
  >,
  access: Pick<ReturnType<typeof createAccessController>, "requireChange">,
) {
  const project = (userID: string, changeID: string) => access.requireChange(userID, changeID);
  return {
    async status(userID: string, changeID: string) {
      await project(userID, changeID);
      return confirmed(await writers.status(changeID, userID));
    },
    async observe(userID: string, changeID: string) {
      await project(userID, changeID);
      // view() also reconciles an already settled writer or persisted handoff.
      // Browser cancellation must not interrupt that existing lifecycle.
      return confirmed(await writers.view(changeID, userID));
    },
    async takeOver(userID: string, changeID: string, raw: z.input<typeof writerTakeoverCommand>) {
      await project(userID, changeID);
      const input = writerTakeoverCommand.parse(raw);
      return confirmed(
        await writers.takeOver(
          changeID,
          userID,
          input.commandID,
          undefined,
          undefined,
          input.epoch,
        ),
      );
    },
    async request(userID: string, changeID: string, raw: z.input<typeof editingCommand>) {
      await project(userID, changeID);
      const input = editingCommand.parse(raw);
      return confirmed(await writers.request(changeID, userID, input.commandID, input.epoch));
    },
    async approve(userID: string, changeID: string, raw: z.input<typeof editingCommand>) {
      await project(userID, changeID);
      const input = editingCommand.parse(raw);
      return confirmed(
        await writers.approve(
          changeID,
          userID,
          input.commandID,
          z.uuid().parse(input.requestID),
          input.epoch,
        ),
      );
    },
    async release(userID: string, changeID: string, raw: z.input<typeof editingCommand>) {
      await project(userID, changeID);
      const input = editingCommand.parse(raw);
      return confirmed(await writers.release(changeID, userID, input.commandID, input.epoch));
    },
    async takeIdle(userID: string, changeID: string, raw: z.input<typeof editingCommand>) {
      await project(userID, changeID);
      const input = editingCommand.parse(raw);
      return confirmed(await writers.takeIdle(changeID, userID, input.commandID, input.epoch));
    },
    async activity(userID: string, changeID: string, raw: z.input<typeof writerActivityCommand>) {
      await project(userID, changeID);
      const input = writerActivityCommand.parse(raw);
      await writers.activity(changeID, userID, input.epoch, input.kind);
    },
  };
}
