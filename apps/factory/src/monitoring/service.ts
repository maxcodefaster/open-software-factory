import type { z } from "zod";
import {
  monitoringChange,
  monitoringSave,
  monitoringView,
} from "../../../../packages/conversation-domain/src/monitoring";
import type { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import type { createMonitoringController } from "./controller";

function command<T>(input: unknown, schema: z.ZodType<T>): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new CommandError("invalid", "Invalid Input settings");
  }
  if (new TextEncoder().encode(serialized).byteLength > 16_000)
    throw new CommandError("conflict", "Input command is too large");
  return schema.parse(input);
}

export function createInputService(
  controller: Pick<ReturnType<typeof createMonitoringController>, "view" | "save" | "change">,
  access: Pick<ReturnType<typeof createAccessController>, "requireProject">,
) {
  return {
    async get(userID: string, projectID: string) {
      await access.requireProject(userID, projectID);
      return monitoringView.parse(await controller.view(projectID, userID));
    },
    async save(userID: string, projectID: string, input: z.input<typeof monitoringSave>) {
      await access.requireProject(userID, projectID);
      return controller.save(projectID, userID, command(input, monitoringSave));
    },
    async disable(
      userID: string,
      projectID: string,
      id: string,
      input: z.input<typeof monitoringChange>,
    ) {
      await access.requireProject(userID, projectID);
      return controller.change(projectID, id, userID, "disable", command(input, monitoringChange));
    },
    async rotate(
      userID: string,
      projectID: string,
      id: string,
      input: z.input<typeof monitoringChange>,
    ) {
      await access.requireProject(userID, projectID);
      return controller.change(projectID, id, userID, "rotate", command(input, monitoringChange));
    },
  };
}
