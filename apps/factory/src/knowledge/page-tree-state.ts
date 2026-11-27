import type { KnowledgePageOutline } from "./contracts";

export function defaultExpandedKeys(
  pages: readonly Pick<KnowledgePageOutline, "id" | "parentId">[],
): string[] {
  const parents = new Set<string>();
  for (const page of pages) {
    if (page.parentId) parents.add(page.parentId);
  }
  const keys = ["wiki"];
  for (const page of pages) {
    if (page.parentId === null && parents.has(page.id)) keys.push(page.id);
  }
  return keys;
}
