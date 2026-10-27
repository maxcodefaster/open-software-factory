import { defineMutatorWithType, type ReadonlyJSONObject } from "@rocicorp/zero";
import type { z } from "zod";
import {
  knowledgePageIconInput,
  moveKnowledgePageInput,
  movePageOrder,
} from "../../knowledge-domain/src/page-tree";
import { type FactoryZeroContext, type FactoryZeroSchema, zql } from "./schema";
import { validator } from "./validation";

export const moveKnowledgePageValidator = validator<
  ReadonlyJSONObject & z.infer<typeof moveKnowledgePageInput>
>((value) => moveKnowledgePageInput.parse(value));
export const knowledgePageIconValidator = validator<
  ReadonlyJSONObject & z.infer<typeof knowledgePageIconInput>
>((value) => knowledgePageIconInput.parse(value));
const defineMutator = defineMutatorWithType<FactoryZeroSchema, FactoryZeroContext>();
export const knowledgeMutators = {
  move: defineMutator(moveKnowledgePageValidator, async ({ tx, args }) => {
    const pages = await tx.run(
      zql.knowledgePageOutline.where("projectId", args.projectId).where("state", "active"),
    );
    const current = pages.find((page) => page.id === args.pageId);
    if (!current) throw new Error("Wiki page not found");
    const order = movePageOrder(pages, args.pageId, args.parentId, args.beforeId);
    for (const [sortOrder, id] of order.entries()) {
      const page = pages.find((page) => page.id === id);
      if (page && (page.sortOrder !== sortOrder || (page.parentId ?? null) !== args.parentId)) {
        const update = {
          id,
          parentId: args.parentId,
          sortOrder,
          metadataVersion: page.metadataVersion + 1,
        };
        await tx.mutate.knowledgePageOutline.update(update);
        await tx.mutate.knowledgePage.update(update);
      }
    }
  }),
  setIcon: defineMutator(knowledgePageIconValidator, async ({ tx, args }) => {
    const page = await tx.run(
      zql.knowledgePageOutline
        .where("id", args.pageId)
        .where("projectId", args.projectId)
        .where("state", "active")
        .one(),
    );
    if (!page) throw new Error("Wiki page not found");
    if (page.icon !== args.icon) {
      const update = {
        id: page.id,
        icon: args.icon,
        metadataVersion: page.metadataVersion + 1,
      };
      await tx.mutate.knowledgePageOutline.update(update);
      await tx.mutate.knowledgePage.update(update);
    }
  }),
};
