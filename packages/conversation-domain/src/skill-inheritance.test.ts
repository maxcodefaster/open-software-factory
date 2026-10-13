import { expect, test } from "bun:test";
import { requirementsInterviewSkill } from "../../../apps/factory/src/skills/reviewed";
import { resolveRoleSkills } from "./skill-inheritance";
import type { SkillRevision } from "./skills";

const required = crypto.randomUUID();
const optional = crypto.randomUUID();
const other = crypto.randomUUID();
const revisions: SkillRevision[] = [required, optional, other].map((id, index) => ({
  id,
  revision: 1,
  content: { ...requirementsInterviewSkill, key: `planning-${index}` },
  digest: "a".repeat(64),
  published: true,
}));
const base = {
  role: "planning" as const,
  system: { required: [required], optional: [optional, other], selected: [optional] },
  project: { required: [], optional: null, selected: null },
  personal: null,
  revisions,
};

test("required baselines are additive and Reset restores inherited optional choices", () => {
  expect(resolveRoleSkills(base)).toMatchObject({
    required: [{ revisionId: required, source: "system" }],
    selected: [optional],
    source: "system",
  });
  const project = { required: [other], optional: [optional], selected: [] };
  expect(resolveRoleSkills({ ...base, project, personal: [] })).toMatchObject({
    required: [
      { revisionId: required, source: "system" },
      { revisionId: other, source: "project" },
    ],
    selected: [],
    source: "personal",
  });
  expect(resolveRoleSkills({ ...base, project })).toMatchObject({
    selected: [],
    source: "project",
    optional: [optional],
  });
});

test("obsolete lower-scope choices cannot widen permissions or select another revision", () => {
  const widened = resolveRoleSkills({
    ...base,
    project: { required: [crypto.randomUUID()], optional: [optional, other], selected: [other] },
    personal: [required, crypto.randomUUID()],
  });
  expect(widened.required).toEqual([{ revisionId: required, source: "system" }]);
  expect(widened.selected).toEqual([]);
  expect(widened.ignoredReason).not.toBeNull();
  expect(
    resolveRoleSkills({
      ...base,
      project: { required: [], optional: [], selected: null },
      personal: [optional],
    }).selected,
  ).toEqual([]);
});

test("withdrawal and role mismatch block required or selected Skills without substituting revisions", () => {
  const withdrawn = revisions.map((revision) => ({
    ...revision,
    published: revision.id !== required,
  }));
  expect(resolveRoleSkills({ ...base, revisions: withdrawn }).available).toBe(false);
  expect(resolveRoleSkills({ ...base, role: "build" }).available).toBe(false);
  expect(
    resolveRoleSkills({
      ...base,
      revisions: revisions.map((revision) => ({
        ...revision,
        published: revision.id !== optional,
      })),
    }).available,
  ).toBe(false);
});

test("republishing a previous Project baseline does not restore removed System permission", () => {
  const project = { required: [optional], optional: [], selected: [] };
  expect(resolveRoleSkills({ ...base, project }).required).toContainEqual({
    revisionId: optional,
    source: "project",
  });
  const resolved = resolveRoleSkills({
    ...base,
    project,
    system: { required: [], optional: [other], selected: [] },
  });
  expect(resolved).toMatchObject({ required: [], selected: [], available: true });
  expect(resolved.ignoredReason).not.toBeNull();
});
