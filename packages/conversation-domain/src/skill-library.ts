import { z } from "zod";
import { skillContentInput, skillRevisionInput, skillRoleInput } from "./skills";
import { libraryCoverState } from "./library-covers";

export const skillScopeInput = z.enum(["system", "project", "personal"]);
export type SkillScope = z.infer<typeof skillScopeInput>;
export const skillLibrarySaveInput = z
  .object({
    libraryId: z.uuid(),
    revisionId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    scope: skillScopeInput,
    projectId: z.uuid().optional(),
    content: skillContentInput,
  })
  .strict();
export const skillChoiceInput = z
  .object({
    libraryId: z.uuid(),
    scope: skillScopeInput,
    projectId: z.uuid().optional(),
    role: skillRoleInput,
    state: z.enum(["inherit", "enable", "disable", "required"]),
    revisionId: z.uuid().optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export const skillChoiceView = z.object({
  libraryId: z.uuid(),
  scope: skillScopeInput,
  role: skillRoleInput,
  state: z.enum(["inherit", "enable", "disable", "required"]),
  revisionId: z.uuid(),
  version: z.number(),
});
export type LibraryChoice = z.infer<typeof skillChoiceView>;
export const libraryEntryInput = z.object({
  id: z.uuid(),
  scope: skillScopeInput,
  ownerId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  revisions: z.array(skillRevisionInput),
  editable: z.boolean(),
  cover: libraryCoverState.nullable().optional(),
});
export type SkillLibraryEntry = z.infer<typeof libraryEntryInput>;
export const skillLibraryView = z.object({
  sharedVersions: z.array(skillRevisionInput),
  entries: z.array(libraryEntryInput),
  choices: z.array(skillChoiceView),
  canManageProject: z.boolean(),
  canManageSystem: z.boolean(),
  proposals: z.array(
    z.object({
      id: z.uuid(),
      revisionId: z.uuid(),
      target: z.enum(["project", "system"]),
      projectId: z.uuid().nullable(),
      name: z.string(),
    }),
  ),
});
export type SkillLibraryView = z.infer<typeof skillLibraryView>;

// A choice only affects this library identity. Untouched identities continue to inherit.
// The revision is exact; a newer publication never changes an existing choice.
export function resolveLibraryChoice(
  choices: LibraryChoice[],
  libraryId: string,
  role: "planning" | "build",
  personal = true,
) {
  const ordered = ["system", "project", ...(personal ? ["personal"] : [])];
  let effective: LibraryChoice | undefined;
  for (const scope of ordered) {
    const choice = choices.find(
      (item) => item.libraryId === libraryId && item.role === role && item.scope === scope,
    );
    if (effective?.state === "required") continue;
    if (choice && choice.state !== "inherit") effective = choice;
  }
  return effective;
}

export function librarySkillIds(
  entries: SkillLibraryEntry[],
  choices: LibraryChoice[],
  role: "planning" | "build",
) {
  return librarySkillAssignments(entries, choices, role).map((item) => item.revisionId);
}

export function librarySkillAssignments(
  entries: SkillLibraryEntry[],
  choices: LibraryChoice[],
  role: "planning" | "build",
) {
  return entries.flatMap((entry) => {
    const choice = resolveLibraryChoice(choices, entry.id, role);
    if (!choice || choice.state === "disable") return [];
    const revision = entry.revisions.find((item) => item.id === choice.revisionId);
    if (!revision?.published || !revision.content.roles.includes(role))
      throw new Error("An enabled skill version is unavailable");
    return [{ revisionId: revision.id, required: choice.state === "required" }];
  });
}
