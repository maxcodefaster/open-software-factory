import { z } from "zod";
import type {
  feedbackCreateInput,
  feedbackDispatchInput,
  feedbackUpdateInput,
} from "../../../../packages/conversation-domain/src/visual-review";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getVisualReview(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    return context.review.get(context.actorID, change);
  });
}
export async function createReviewFeedback(
  changeID: string,
  input: z.input<typeof feedbackCreateInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.review.create(context.actorID, change, input);
  });
}
export async function updateReviewFeedback(
  changeID: string,
  input: z.input<typeof feedbackUpdateInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.review.update(context.actorID, change, input);
  });
}
export async function sendReviewRevision(
  changeID: string,
  input: z.input<typeof feedbackDispatchInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const change = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.review.send(context.actorID, change, input);
  });
}
