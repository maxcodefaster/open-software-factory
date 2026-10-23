import {
  type LibraryChoice,
  resolveLibraryChoice,
  type SkillLibraryEntry,
  type SkillScope,
} from "../../../../packages/conversation-domain/src/skill-library";
import type { SkillRole } from "../../../../packages/conversation-domain/src/skills";

export const skillRoleLabel = (role: SkillRole) =>
  role === "planning" ? "Investigate & Plan" : "Build";
export const skillScopeLabel = (scope: SkillScope) =>
  scope === "personal" ? "Only me" : scope === "project" ? "Project" : "Factory";
export type SkillChoiceState = LibraryChoice["state"];
export type SkillFilters = {
  query: string;
  owner: "all" | SkillScope;
  role: "all" | SkillRole;
  availability: "all" | "enabled" | "disabled" | "required" | "updates";
};

export function skillAvailability(
  entry: SkillLibraryEntry,
  choices: LibraryChoice[],
  scope: SkillScope,
  role: SkillRole,
) {
  const scoped = choices.filter(
    (choice) =>
      scope === "personal" ||
      (scope === "project" ? choice.scope !== "personal" : choice.scope === "system"),
  );
  const own = scoped.find(
    (choice) => choice.libraryId === entry.id && choice.role === role && choice.scope === scope,
  );
  const inherited = resolveLibraryChoice(
    scoped.filter((choice) => choice.scope !== scope),
    entry.id,
    role,
  );
  const effective = resolveLibraryChoice(scoped, entry.id, role);
  const latest = entry.revisions[0];
  const revision = entry.revisions.find((item) => item.id === effective?.revisionId) ?? latest;
  const compatible = revision?.content.roles.includes(role) ?? false;
  const enabled = compatible && Boolean(effective && effective.state !== "disable");
  const required = enabled && effective?.state === "required";
  const source = effective?.scope;
  return {
    own,
    inherited,
    effective,
    latest,
    revision,
    compatible,
    enabled,
    required,
    locked: inherited?.state === "required",
    updateAvailable: Boolean(effective && revision && latest && revision.id !== latest.id),
    label: !compatible
      ? "Not compatible"
      : required
        ? `Required by ${skillScopeLabel(source ?? "system")}`
        : enabled
          ? source === "personal"
            ? "On · Your choice"
            : `On · ${skillScopeLabel(source ?? "system")} default`
          : source === "personal"
            ? "Off · Your choice"
            : "Off",
  };
}

export function matchesSkill(
  entry: SkillLibraryEntry,
  choices: LibraryChoice[],
  scope: SkillScope,
  filters: SkillFilters,
) {
  if (filters.owner !== "all" && entry.scope !== filters.owner) return false;
  const roles = filters.role === "all" ? (["planning", "build"] as const) : [filters.role];
  const states = roles
    .map((role) => skillAvailability(entry, choices, scope, role))
    .filter((state) => state.compatible);
  if (!states.length) return false;
  const query = filters.query.trim().toLocaleLowerCase();
  // Search the displayed pinned versions as well as the latest publication.
  if (
    query &&
    ![entry.revisions[0], ...states.map((state) => state.revision)].some(
      (revision) =>
        revision &&
        `${revision.content.name} ${revision.content.description} ${revision.content.key}`
          .toLocaleLowerCase()
          .includes(query),
    )
  )
    return false;
  switch (filters.availability) {
    case "enabled":
      return states.some((state) => state.enabled);
    case "disabled":
      return states.every((state) => !state.enabled);
    case "required":
      return states.some((state) => state.required);
    case "updates":
      return states.some((state) => state.updateAvailable);
    default:
      return true;
  }
}
