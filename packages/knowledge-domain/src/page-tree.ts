import { z } from "zod";

export const knowledgeIcons = [
  "knowledge",
  "home",
  "ticket",
  "ide",
  "preview",
  "settings",
] as const;
export const moveKnowledgePageInput = z.object({
  projectId: z.uuid(),
  pageId: z.uuid(),
  expectedMetadataVersion: z.number().int().positive(),
  parentId: z.uuid().nullable(),
  beforeId: z.uuid().nullable(),
});
export const knowledgePageIconInput = z.object({
  projectId: z.uuid(),
  pageId: z.uuid(),
  expectedMetadataVersion: z.number().int().positive(),
  icon: z.enum(knowledgeIcons),
});
export type KnowledgeNode = {
  id: string;
  parentId?: string | null | undefined;
  sortOrder: number;
  title: string;
};

export function pageParentWouldCycle(
  pages: readonly KnowledgeNode[],
  id: string,
  parentId: string | null,
) {
  const parents = new Map(pages.map((page) => [page.id, page.parentId]));
  const seen = new Set([id]);
  let parent = parentId;
  while (parent) {
    if (seen.has(parent)) return true;
    seen.add(parent);
    parent = parents.get(parent) ?? null;
  }
  return false;
}

export function pageSiblings<T extends KnowledgeNode>(
  pages: readonly T[],
  parentId: string | null,
) {
  return pages
    .filter((page) => (page.parentId ?? null) === parentId)
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
    );
}

/** The returned order is shared by optimistic and authoritative planning mutations. */
export function movePageOrder(
  pages: readonly KnowledgeNode[],
  id: string,
  parentId: string | null,
  beforeId: string | null,
) {
  if (!pages.some((page) => page.id === id)) throw new Error("Wiki page not found");
  if (parentId && !pages.some((page) => page.id === parentId))
    throw new Error("Parent page not found");
  if (pageParentWouldCycle(pages, id, parentId))
    throw new Error("Wiki pages cannot contain a cycle");
  const siblings = pageSiblings(pages, parentId).filter((page) => page.id !== id);
  const index =
    beforeId === null ? siblings.length : siblings.findIndex((page) => page.id === beforeId);
  if (index < 0 || beforeId === id) throw new Error("Move target is not a sibling");
  const ids = siblings.map((page) => page.id);
  ids.splice(index, 0, id);
  return ids;
}
