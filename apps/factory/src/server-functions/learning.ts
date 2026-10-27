import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  learningDecisionCommand,
  learningPolicyCommand,
  learningRollbackCommand,
  learningView,
} from "../../../../packages/conversation-domain/src/learning";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getLearning = createServerFn({ method: "POST" })
  .validator((args: [projectId: string | null, personal?: boolean | undefined]) => args)
  .handler(async ({ data: [projectId, personal = false] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return learningView.parse(
        await context.learning.get(
          context.actorID,
          z.uuid().nullable().parse(projectId),
          z.boolean().parse(personal),
        ),
      );
    });
  });
export const saveLearning = createServerFn({ method: "POST", strict: { output: false } })
  .validator((args: [input: z.input<typeof learningPolicyCommand>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      const command = learningPolicyCommand.parse(input);
      await context.beforeWrite(true);
      return context.learning.set(context.actorID, command);
    });
  });
export const decideLearning = createServerFn({ method: "POST", strict: { output: false } })
  .validator((args: [input: z.input<typeof learningDecisionCommand>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      const command = learningDecisionCommand.parse(input);
      await context.beforeWrite(true);
      return context.learning.decide(context.actorID, command);
    });
  });
export const rollbackLearning = createServerFn({ method: "POST", strict: { output: false } })
  .validator((args: [input: z.input<typeof learningRollbackCommand>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      const command = learningRollbackCommand.parse(input);
      await context.beforeWrite(true);
      return context.learning.rollback(context.actorID, command);
    });
  });
