import { z } from "zod";

export const createEpicInput = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(""),
    parentId: z.uuid().nullable().default(null),
  })
  .strict()
  .refine((value) => value.id !== value.parentId, "An Epic cannot be its own parent");

export const updateEpicInput = z
  .object({
    projectId: z.uuid(),
    epicId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    parentId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => value.epicId !== value.parentId, "An Epic cannot be its own parent")
  .refine(
    (value) =>
      value.title !== undefined || value.description !== undefined || value.parentId !== undefined,
    "An Epic update must change a planning field",
  );

export const assignTicketEpicInput = z
  .object({
    projectId: z.uuid(),
    ticketId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    epicId: z.uuid().nullable(),
  })
  .strict();

export function epicParentWouldCycle(
  epics: readonly { id: string; parentId?: string | null }[],
  epicId: string,
  parentId: string | null,
) {
  const parents = new Map(epics.map((epic) => [epic.id, epic.parentId]));
  const visited = new Set<string>();
  let current: string | null | undefined = parentId;
  while (current) {
    if (current === epicId || visited.has(current)) return true;
    visited.add(current);
    current = parents.get(current);
  }
  return false;
}

export function epicFamilyIds(
  epics: readonly { id: string; parentId?: string | null }[],
  epicId: string,
) {
  const children = new Map<string, string[]>();
  for (const epic of epics) {
    if (epic.parentId)
      children.set(epic.parentId, [...(children.get(epic.parentId) ?? []), epic.id]);
  }
  const family = new Set<string>();
  const remaining = [epicId];
  while (remaining.length) {
    const id = remaining.pop();
    if (!id || family.has(id)) continue;
    family.add(id);
    remaining.push(...(children.get(id) ?? []));
  }
  return family;
}
