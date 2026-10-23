import { defineMutatorWithType, type ReadonlyJSONObject } from "@rocicorp/zero";
import {
  type DesktopBackgroundKey,
  isDesktopBackgroundKey,
} from "../../interface-domain/src/background";
import { type FactoryZeroContext, type FactoryZeroSchema, zql } from "./schema";
import { record, uuid, validator } from "./validation";

type BackgroundArgs = ReadonlyJSONObject & {
  projectId: string;
  desktopBackgroundKey: DesktopBackgroundKey;
};

export const projectBackgroundValidator = validator<BackgroundArgs>((value) => {
  const { desktopBackgroundKey, projectId } = record(value);
  if (!isDesktopBackgroundKey(desktopBackgroundKey))
    throw new TypeError("Choose a background from the Project artwork collection");
  return {
    projectId: uuid(projectId, "projectId"),
    desktopBackgroundKey,
  };
});

const defineMutator = defineMutatorWithType<FactoryZeroSchema, FactoryZeroContext>();

export const projectMutators = {
  setBackground: defineMutator(projectBackgroundValidator, async ({ tx, ctx, args }) => {
    const project = await tx.run(zql.project.where("id", args.projectId).one());
    if (!project) throw new Error("Project not found");
    if (!ctx.systemManager) {
      const member = await tx.run(
        zql.projectMembership.where("projectId", args.projectId).where("userId", ctx.userId).one(),
      );
      if (!member?.manageProject) throw new Error("Project Manager access required");
    }
    await tx.mutate.project.update({
      id: args.projectId,
      desktopBackgroundKey: args.desktopBackgroundKey,
      updatedAt: Date.now(),
    });
  }),
};
