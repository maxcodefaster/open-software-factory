import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import type {
  feedbackCreateInput,
  feedbackDispatchInput,
  feedbackUpdateInput,
} from "../../../../packages/conversation-domain/src/visual-review";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getVisualReview = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      return context.review.get(context.actorID, change);
    });
  });
export const createReviewFeedback = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof feedbackCreateInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.review.create(context.actorID, change, input);
    });
  });
export const updateReviewFeedback = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof feedbackUpdateInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.review.update(context.actorID, change, input);
    });
  });
export const sendReviewRevision = createServerFn({ method: "POST" })
  .validator((args: [changeID: string, input: z.input<typeof feedbackDispatchInput>]) => args)
  .handler(async ({ data: [changeID, input] }) => {
    return factoryFunction(async () => {
      const change = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.review.send(context.actorID, change, input);
    });
  });
