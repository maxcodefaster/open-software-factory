import { expect, test } from "bun:test";
import { requirementsInterviewSkill } from "../../../apps/factory/src/skills/reviewed";
import { skillContentInput, skillInstructionText, skillRoleSettingsInput } from "./skills";

test("reviewed planning Skill retains pinned provenance, licence and its bundled reference", () => {
  const content = skillContentInput.parse(requirementsInterviewSkill);
  const text = skillInstructionText([
    { id: crypto.randomUUID(), revision: 1, content, digest: "a".repeat(64), published: true },
  ]);
  expect(text).toContain(content.instructions);
  expect(text).toContain(content.references[0]?.body ?? "missing reference");
  expect(content.origin?.commit).toHaveLength(40);
  expect(content.origin?.licenceText).toContain("Copyright (c) 2026 Matt Pocock");
});

test("references accept only bundled instruction paths, never executable or traversal paths", () => {
  for (const path of [
    "../secret.md",
    "references/../../secret.md",
    "/etc/passwd",
    "references/run.sh",
    "references/run.js",
    "references/run.ts",
    "references/%2e%2e/secret.md",
    "https://example.org/file.md",
    "references\\secret.md",
    "references/.env",
    "references/a.md/secret.md",
  ]) {
    expect(
      skillContentInput.safeParse({
        ...requirementsInterviewSkill,
        references: [{ path, body: "Not executable" }],
      }).success,
    ).toBe(false);
  }
  expect(
    skillContentInput.safeParse({ ...requirementsInterviewSkill, scripts: ["run.sh"] }).success,
  ).toBe(false);
  expect(
    skillContentInput.safeParse({ ...requirementsInterviewSkill, tools: ["approve-delivery"] })
      .success,
  ).toBe(false);
  expect(
    skillContentInput.safeParse({
      ...requirementsInterviewSkill,
      origin: { ...requirementsInterviewSkill.origin, commit: "main" },
    }).success,
  ).toBe(false);
});

test("role settings reject duplicate, contradictory and unapproved optional selections", () => {
  const id = crypto.randomUUID();
  expect(
    skillRoleSettingsInput.safeParse({ required: [id], optional: [id], selected: [] }).success,
  ).toBe(false);
  expect(
    skillRoleSettingsInput.safeParse({ required: [], optional: [], selected: [id] }).success,
  ).toBe(false);
  expect(
    skillRoleSettingsInput.safeParse({ required: [id, id], optional: [], selected: [] }).success,
  ).toBe(false);
});

test("publication rejects multibyte content that would exceed its stored immutable payload bound", () => {
  expect(
    skillContentInput.safeParse({
      ...requirementsInterviewSkill,
      instructions: "文".repeat(24_000),
      references: [{ path: "references/checks.md", body: "文".repeat(16_000) }],
    }).success,
  ).toBe(false);
});
