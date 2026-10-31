import type { z } from "zod";
import {
  type deliveryDelegationInput,
  deliverySettingsView,
  type promotionRetryInput,
} from "../../../../packages/change-domain/src/delivery";
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
    | "get"
    | "approve"
    | "retryReview"
    | "retryPromotion"
    | "resumeChecks"
    | "retryBootstrap"
    | "settings"
    | "configure"
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
    async settings(userID: string, projectID: string) {
      return deliverySettingsView.parse(await options.controller.settings(projectID, userID));
    },
    async configure(
      userID: string,
      projectID: string,
      input: z.input<typeof deliveryDelegationInput>,
    ) {
      return deliverySettingsView.parse(
        await options.controller.configure(projectID, userID, input),
      );
    },
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
    async retryPromotion(
      userID: string,
      changeID: string,
      input: z.output<typeof promotionRetryInput>,
    ) {
      const projectID = await options.access.requireChange(userID, changeID);
      await options.access.requireDevelopment(userID, projectID);
      return dto(
        await options.controller.retryPromotion(
          changeID,
          userID,
          input.commandId,
          input.promotionId,
        ),
      );
    },
    async resumeChecks(
      userID: string,
      changeID: string,
      input: z.output<typeof verificationResumeInput>,
    ) {
      const projectID = await options.access.requireChange(userID, changeID);
      await options.access.requireDevelopment(userID, projectID);
      if ("runtimeAttemptId" in input)
        return dto(
          await options.controller.retryBootstrap(
            changeID,
            userID,
            input.commandId,
            input.verificationId,
            input.runtimeAttemptId,
          ),
        );
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
