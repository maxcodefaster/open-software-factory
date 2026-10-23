import { expect, test } from "bun:test";
import type {
  LibraryChoice,
  SkillLibraryEntry,
} from "../../../../packages/conversation-domain/src/skill-library";
import { matchesSkill, type SkillFilters, skillAvailability } from "./gallery-state";

const revision = (id: string, number: number, roles: Array<"planning" | "build">) => ({
  id,
  revision: number,
  digest: "a".repeat(64),
  published: true,
  content: {
    key: "review-code",
    name: `Code review v${number}`,
    description: "Inspect changed source before delivery.",
    instructions: "Read the diff.",
    roles,
    references: [],
  },
});
const entry: SkillLibraryEntry = {
  id: "library",
  scope: "system",
  ownerId: null,
  projectId: null,
  editable: false,
  revisions: [revision("new", 2, ["build"]), revision("old", 1, ["planning", "build"])],
};
const choice = (
  scope: LibraryChoice["scope"],
  state: LibraryChoice["state"],
  role: LibraryChoice["role"] = "build",
): LibraryChoice => ({
  libraryId: entry.id,
  scope,
  state,
  role,
  revisionId: "old",
  version: 1,
});
const filters: SkillFilters = { query: "", owner: "all", role: "all", availability: "all" };

test("gallery availability preserves required inheritance and names its authority", () => {
  const state = skillAvailability(
    entry,
    [choice("system", "enable"), choice("project", "required"), choice("personal", "disable")],
    "personal",
    "build",
  );
  expect(state.enabled).toBe(true);
  expect(state.locked).toBe(true);
  expect(state.label).toBe("Required by Project");
  expect(state.revision?.id).toBe("old");
  expect(state.updateAvailable).toBe(true);
});

test("shared defaults do not display a person's override or accept a lower scope", () => {
  const choices = [
    choice("system", "disable"),
    choice("project", "enable"),
    choice("personal", "disable"),
  ];
  expect(skillAvailability(entry, choices, "project", "build").enabled).toBe(true);
  expect(skillAvailability(entry, choices, "system", "build").enabled).toBe(false);
  expect(skillAvailability(entry, choices, "personal", "build").enabled).toBe(false);
});

test("untouched guidance is off, and disabled pinned guidance is not enabled", () => {
  expect(skillAvailability(entry, [], "personal", "build").label).toBe("Off");
  const state = skillAvailability(entry, [choice("personal", "disable")], "personal", "build");
  expect(state.enabled).toBe(false);
  expect(state.label).toBe("Off · Your choice");
  expect(state.updateAvailable).toBe(true);
});

test("filters use supported metadata and compatible pinned versions", () => {
  const choices = [choice("system", "enable", "planning")];
  expect(matchesSkill(entry, choices, "personal", { ...filters, role: "planning" })).toBe(true);
  expect(matchesSkill(entry, [], "personal", { ...filters, role: "planning" })).toBe(false);
  expect(matchesSkill(entry, choices, "personal", { ...filters, query: " V1 " })).toBe(true);
  expect(matchesSkill(entry, choices, "personal", { ...filters, query: "review-code" })).toBe(true);
  expect(matchesSkill(entry, choices, "personal", { ...filters, owner: "personal" })).toBe(false);
  expect(matchesSkill(entry, choices, "personal", { ...filters, availability: "updates" })).toBe(
    true,
  );
  expect(matchesSkill(entry, choices, "personal", { ...filters, availability: "enabled" })).toBe(
    true,
  );
  expect(matchesSkill(entry, choices, "personal", { ...filters, availability: "disabled" })).toBe(
    false,
  );
});
