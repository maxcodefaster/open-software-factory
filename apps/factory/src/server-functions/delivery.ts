import { z } from "zod";
import {
  candidateReviewRetryInput,
  verificationResumeInput,
} from "../../../../packages/conversation-domain/src/candidate-review";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getDelivery(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    return context.delivery.get(context.actorID, id);
  });
}
export async function approveDelivery(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.delivery.approve(context.actorID, id);
  });
}
export async function retryCandidateReview(
  changeID: string,
  input: z.input<typeof candidateReviewRetryInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      value = candidateReviewRetryInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.delivery.retryReview(context.actorID, id, value);
  });
}
export async function resumeVerification(
  changeID: string,
  input: z.input<typeof verificationResumeInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      value = verificationResumeInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.delivery.resumeChecks(context.actorID, id, value);
  });
}
