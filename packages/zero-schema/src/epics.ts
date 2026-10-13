import { defineMutatorWithType, type ReadonlyJSONObject } from "@rocicorp/zero";
import type { z } from "zod";
import {
  assignTicketEpicInput,
  createEpicInput,
  epicParentWouldCycle,
  updateEpicInput,
} from "../../ticket-domain/src/epic";
import { type FactoryZeroContext, type FactoryZeroSchema, zql } from "./schema";
import { validator } from "./validation";

export const createEpicValidator = validator<ReadonlyJSONObject & z.infer<typeof createEpicInput>>(
  (value) => createEpicInput.parse(value),
);
export const updateEpicValidator = validator<ReadonlyJSONObject & z.infer<typeof updateEpicInput>>(
  (value) => updateEpicInput.parse(value),
);
export const assignTicketEpicValidator = validator<
  ReadonlyJSONObject & z.infer<typeof assignTicketEpicInput>
>((value) => assignTicketEpicInput.parse(value));
const defineMutator = defineMutatorWithType<FactoryZeroSchema, FactoryZeroContext>();

export const epicMutators = {
  create: defineMutator(createEpicValidator, async ({ tx, ctx, args }) => {
    const project = await tx.run(zql.project.where("id", args.projectId).one());
    if (!project) throw new Error("Project not found");
    if (args.parentId) {
      const parent = await tx.run(
        zql.epic.where("id", args.parentId).where("projectId", args.projectId).one(),
      );
      if (!parent) throw new Error("Parent Epic not found");
    }
    const now = Date.now();
    await tx.mutate.epic.insert({
      ...args,
      version: 1,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
  }),
  update: defineMutator(updateEpicValidator, async ({ tx, args }) => {
    const current = await tx.run(
      zql.epic.where("id", args.epicId).where("projectId", args.projectId).one(),
    );
    if (!current) return;
    if (args.parentId !== undefined && args.parentId !== null) {
      const epics = await tx.run(zql.epic.where("projectId", args.projectId));
      if (!epics.some((epic) => epic.id === args.parentId))
        throw new Error("Parent Epic not found");
      if (epicParentWouldCycle(epics, current.id, args.parentId))
        throw new Error("Epic hierarchy cannot contain a cycle");
    }
    await tx.mutate.epic.update({
      id: current.id,
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.parentId === undefined ? {} : { parentId: args.parentId }),
      version: Math.max(current.version + 1, args.expectedVersion + 1),
      updatedAt: Date.now(),
    });
  }),
};

export const assignTicketEpicMutator = defineMutator(
  assignTicketEpicValidator,
  async ({ tx, args }) => {
    const current = await tx.run(
      zql.ticket.where("id", args.ticketId).where("projectId", args.projectId).one(),
    );
    if (!current) return;
    if (current.trashedAt) throw new Error("Restore the Ticket before editing");
    if (current.convertedToEpicId)
      throw new Error("Open the Epic instead of editing the original intent");
    if (args.epicId) {
      const epic = await tx.run(
        zql.epic.where("id", args.epicId).where("projectId", args.projectId).one(),
      );
      if (!epic) throw new Error("Epic not found");
    }
    await tx.mutate.ticket.update({
      id: current.id,
      epicId: args.epicId,
      version: Math.max(current.version + 1, args.expectedVersion + 1),
      updatedAt: Date.now(),
    });
  },
);
