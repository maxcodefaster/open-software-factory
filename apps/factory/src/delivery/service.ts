import type { z } from "zod";
import type {
  candidateReviewRetryInput,
  verificationResumeInput,
} from "../../../../packages/conversation-domain/src/candidate-review";
import type { createAccessController } from "../access/controller";
import { deliveryViewSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import type { createDeliveryController } from "./controller";

export function createDeliveryService(options: {
  access: Pick<ReturnType<typeof createAccessController>, "requireChange" | "requireDevelopment">;
  controller: Pick<
    ReturnType<typeof createDeliveryController>,
    "get" | "approve" | "retryReview" | "resumeChecks"
  >;
}) {
  const dto = (value: Record<string, unknown> | null) => {
    if (!value) throw new CommandError("not-found", "Change not found");
    return deliveryViewSchema.parse({
      ...value,
      approvedAt:
        value["approvedAt"] instanceof Date
          ? value["approvedAt"].toISOString()
          : value["approvedAt"],
    });
  };
  return {
    async get(userID: string, changeID: string) {
      await options.access.requireChange(userID, changeID);
      return dto(await options.controller.get(changeID));
    },
    async approve(userID: string, changeID: string) {
      const projectID = await options.access.requireChange(userID, changeID);
      await options.access.requireDevelopment(userID, projectID);
      return dto(await options.controller.approve(changeID, userID));
    },
    async retryReview(
      userID: string,
      changeID: string,
      input: z.output<typeof candidateReviewRetryInput>,
    ) {
      await options.access.requireChange(userID, changeID);
      return dto(
        await options.controller.retryReview(changeID, userID, input.commandId, input.reviewId),
      );
    },
    async resumeChecks(
      userID: string,
      changeID: string,
      input: z.output<typeof verificationResumeInput>,
    ) {
      await options.access.requireChange(userID, changeID);
      return dto(
        await options.controller.resumeChecks(
          changeID,
          userID,
          input.commandId,
          input.verificationId,
          input.stopId,
        ),
      );
    },
  };
}
