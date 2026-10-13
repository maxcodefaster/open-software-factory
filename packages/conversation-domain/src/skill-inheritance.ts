import { z } from "zod";
import {
  type SkillRole,
  type SkillRoleSettings,
  type SkillRevision,
  skillRevisionIDsInput,
  skillRevisionInput,
  systemSkillSettingsInput,
} from "./skills";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectRole = z
  .object({
    required: skillRevisionIDsInput,
    optional: skillRevisionIDsInput.nullable(),
    selected: skillRevisionIDsInput.nullable(),
  })
  .strict();
export const projectSkillSettingsInput = z
  .object({ version, planning: projectRole, build: projectRole })
  .strict();
export const personalSkillSettingsInput = z
  .object({
    version,
    planning: skillRevisionIDsInput.nullable(),
    build: skillRevisionIDsInput.nullable(),
  })
  .strict();
export type ProjectSkillSettings = z.infer<typeof projectSkillSettingsInput>;
export type PersonalSkillSettings = z.infer<typeof personalSkillSettingsInput>;

export const effectiveSkillRoleInput = z.object({
  required: z.array(z.object({ revisionId: z.uuid(), source: z.enum(["system", "project"]) })),
  optional: skillRevisionIDsInput,
  selected: skillRevisionIDsInput,
  source: z.enum(["system", "project", "personal"]),
  available: z.boolean(),
  ignoredReason: z.string().nullable(),
});
export type EffectiveSkillRole = z.infer<typeof effectiveSkillRoleInput>;
export const systemSkillSettingsView = z.object({
  settings: systemSkillSettingsInput,
  revisions: z.array(skillRevisionInput),
});
export const inheritedSkillSettingsView = z.object({
  system: systemSkillSettingsInput,
  project: projectSkillSettingsInput,
  personal: personalSkillSettingsInput,
  revisions: z.array(skillRevisionInput),
  effective: z.object({ planning: effectiveSkillRoleInput, build: effectiveSkillRoleInput }),
  projectEffective: z.object({ planning: effectiveSkillRoleInput, build: effectiveSkillRoleInput }),
  canManageProject: z.boolean(),
});
export type InheritedSkillSettings = z.infer<typeof inheritedSkillSettingsView>;

export function resolveRoleSkills(input: {
  role: SkillRole;
  system: SkillRoleSettings;
  project: ProjectSkillSettings[SkillRole];
  personal: string[] | null;
  revisions: SkillRevision[];
}): EffectiveSkillRole {
  const required = [
    ...input.system.required.map((revisionId) => ({ revisionId, source: "system" as const })),
    ...input.project.required
      .filter((id) => input.system.optional.includes(id) && !input.system.required.includes(id))
      .map((revisionId) => ({ revisionId, source: "project" as const })),
  ];
  const optional = input.system.optional.filter(
    (id) =>
      !required.some((required) => required.revisionId === id) &&
      (input.project.optional === null || input.project.optional.includes(id)),
  );
  const selection = input.personal ?? input.project.selected ?? input.system.selected;
  const selected = selection.filter((id) => optional.includes(id));
  const ignored =
    input.project.required.some((id) => !input.system.optional.includes(id)) ||
    selection.some((id) => !optional.includes(id));
  const ids = [...required.map((item) => item.revisionId), ...selected];
  return {
    required,
    optional,
    selected,
    source:
      input.personal !== null ? "personal" : input.project.selected !== null ? "project" : "system",
    available: ids.every((id) => {
      const revision = input.revisions.find((revision) => revision.id === id);
      return Boolean(revision?.published && revision.content.roles.includes(input.role));
    }),
    ignoredReason: ignored
      ? "Saved choices outside the current inherited permissions are ignored."
      : null,
  };
}
