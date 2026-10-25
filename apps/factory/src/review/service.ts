import { z } from "zod";
import {
  feedbackCreateInput,
  feedbackDispatchInput,
  feedbackUpdateInput,
  visualReviewSchema,
} from "../../../../packages/conversation-domain/src/visual-review";
import type { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import type { createVisualReviewController } from "./controller";

function command<T>(raw: unknown, schema: z.ZodType<T>) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new CommandError("invalid", "Invalid Review command");
  }
  if (new TextEncoder().encode(serialized).byteLength > 32_768)
    throw new CommandError("conflict", "Review request exceeds its size limit");
  return schema.parse(raw);
}
type ReviewController = ReturnType<typeof createVisualReviewController>;
export function createReviewService(options: {
  controller: Pick<ReviewController, "get" | "create" | "update" | "dispatch">;
  access: Pick<ReturnType<typeof createAccessController>, "requireChange">;
  admit(
    changeID: string,
    userID: string,
    ...args: Parameters<Parameters<ReviewController["dispatch"]>[3]>
  ): Promise<string>;
  dispatchPending(changeID: string): Promise<unknown>;
}) {
  const { controller, access } = options;
  return {
    async get(userID: string, changeID: string) {
      await access.requireChange(userID, changeID);
      return visualReviewSchema.parse(await controller.get(changeID, userID));
    },
    async create(userID: string, changeID: string, raw: z.input<typeof feedbackCreateInput>) {
      await access.requireChange(userID, changeID);
      return controller.create(changeID, userID, command(raw, feedbackCreateInput));
    },
    async update(userID: string, changeID: string, raw: z.input<typeof feedbackUpdateInput>) {
      await access.requireChange(userID, changeID);
      return controller.update(changeID, userID, command(raw, feedbackUpdateInput));
    },
    async send(userID: string, changeID: string, raw: z.input<typeof feedbackDispatchInput>) {
      await access.requireChange(userID, changeID);
      const result = await controller.dispatch(
        changeID,
        userID,
        command(raw, feedbackDispatchInput),
        (...args) => options.admit(changeID, userID, ...args),
      );
      // Only persisted pending work may dispatch. Reconnect never admits a new
      // turn, and a failed observation does not replay the human command.
      void options
        .dispatchPending(changeID)
        .catch(() => console.error("Review correction dispatch needs reconciliation"));
      return result;
    },
  };
}
