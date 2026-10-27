import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { deliveryDelegationInput } from "../../../../packages/change-domain/src/delivery";
import {
  candidateReviewRetryInput,
  verificationResumeInput,
} from "../../../../packages/conversation-domain/src/candidate-review";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getDeliverySettings = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.delivery.settings(context.actorID, z.uuid().parse(projectID));
    }),
  );
export const configureDelivery = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof deliveryDelegationInput>]) => args)
  .handler(async ({ data: [projectID, input] }) =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.delivery.configure(
        context.actorID,
        z.uuid().parse(projectID),
        deliveryDelegationInput.parse(input),
      );
    }),
  );

export const getDelivery = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      return context.delivery.get(context.actorID, id);
    });
  });
export const approveDelivery = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.delivery.approve(context.actorID, id);
    });
  });
export const retryCandidateReview = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof candidateReviewRetryInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        value = candidateReviewRetryInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.delivery.retryReview(context.actorID, id, value);
    });
  });
export const resumeVerification = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof verificationResumeInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        value = verificationResumeInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.delivery.resumeChecks(context.actorID, id, value);
    });
  });
