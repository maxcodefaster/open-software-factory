import { defineMutatorWithType, type ReadonlyJSONObject } from "@rocicorp/zero";
import type { z } from "zod";
import { dependencyWouldCycle, ticketDependencyInput } from "../../ticket-domain/src/dependency";
import { type FactoryZeroContext, type FactoryZeroSchema, zql } from "./schema";
import { validator } from "./validation";

export const ticketDependencyValidator = validator<
  ReadonlyJSONObject & z.infer<typeof ticketDependencyInput>
>((value) => ticketDependencyInput.parse(value));
const defineMutator = defineMutatorWithType<FactoryZeroSchema, FactoryZeroContext>();

export const dependencyMutators = {
  add: defineMutator(ticketDependencyValidator, async ({ tx, ctx, args }) => {
    const current = await tx.run(
      zql.ticket.where("id", args.ticketId).where("projectId", args.projectId).one(),
    );
    if (!current) return;
    if (current.trashedAt) throw new Error("Restore the Ticket before editing");
    if (current.convertedToEpicId)
      throw new Error("Open the Epic instead of editing the original intent");
    const target = await tx.run(
      zql.ticket.where("id", args.prerequisiteId).where("projectId", args.projectId).one(),
    );
    if (!target) throw new Error("Prerequisite Ticket not found");
    if (target.trashedAt) throw new Error("Restore the prerequisite Ticket before linking");
    if (target.convertedToEpicId)
      throw new Error("Link an Epic member instead of the original intent");
    const dependencies = await tx.run(zql.ticketDependency.where("projectId", args.projectId));
    if (
      dependencies.some(
        (edge) => edge.ticketId === args.ticketId && edge.prerequisiteId === args.prerequisiteId,
      )
    )
      throw new Error("This prerequisite is already linked");
    if (dependencyWouldCycle(dependencies, args.ticketId, args.prerequisiteId))
      throw new Error("Ticket dependencies cannot contain a cycle");
    const now = Date.now();
    await tx.mutate.ticketDependency.insert({
      projectId: args.projectId,
      ticketId: args.ticketId,
      prerequisiteId: args.prerequisiteId,
      createdBy: ctx.userId,
      createdAt: now,
    });
    await tx.mutate.ticket.update({
      id: args.ticketId,
      version: Math.max(current.version + 1, args.expectedVersion + 1),
      updatedAt: now,
    });
  }),
  remove: defineMutator(ticketDependencyValidator, async ({ tx, args }) => {
    const current = await tx.run(
      zql.ticket.where("id", args.ticketId).where("projectId", args.projectId).one(),
    );
    if (!current) return;
    if (current.trashedAt) throw new Error("Restore the Ticket before editing");
    if (current.convertedToEpicId)
      throw new Error("Open the Epic instead of editing the original intent");
    await tx.mutate.ticketDependency.delete({
      projectId: args.projectId,
      ticketId: args.ticketId,
      prerequisiteId: args.prerequisiteId,
    });
    await tx.mutate.ticket.update({
      id: args.ticketId,
      version: Math.max(current.version + 1, args.expectedVersion + 1),
      updatedAt: Date.now(),
    });
  }),
};
