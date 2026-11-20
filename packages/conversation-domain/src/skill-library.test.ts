import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { previewSkillImport } from "../../../apps/factory/src/skills/import";
import {
  invokedSkills,
  nativeSkillManifest,
  observedNativeSkillIds,
} from "../../../apps/factory/src/skills/native";
import { requirementsInterviewSkill } from "../../../apps/factory/src/skills/reviewed";
import { starterSkills } from "../../../apps/factory/src/skills/starters";
import { fixtureValue } from "../../../test/fixtures/value";
import {
  type LibraryChoice,
  librarySkillAssignments,
  librarySkillIds,
  librarySkillsAvailable,
  resolveLibraryChoice,
} from "./skill-library";
import { skillContentInput } from "./skills";

test("per-skill choices inherit later defaults, lock required versions, and reset one override", () => {
  const id = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const next = crypto.randomUUID();
  const choices: LibraryChoice[] = [
    {
      libraryId: id,
      revisionId: revision,
      role: "planning",
      scope: "system",
      state: "enable",
      version: 1,
    },
  ];
  expect(resolveLibraryChoice(choices, id, "planning")?.revisionId).toBe(revision);
  choices.push({
    libraryId: id,
    revisionId: revision,
    role: "planning",
    scope: "personal",
    state: "disable",
    version: 1,
  });
  expect(resolveLibraryChoice(choices, id, "planning")?.state).toBe("disable");
  choices[1] = { ...fixtureValue(choices[1], "choices[1]"), state: "inherit", version: 2 };
  choices[0] = { ...fixtureValue(choices[0], "choices[0]"), revisionId: next };
  expect(resolveLibraryChoice(choices, id, "planning")?.revisionId).toBe(next);
  choices[0] = { ...choices[0], state: "required" };
  choices[1] = { ...choices[1], state: "enable", revisionId: revision };
  expect(resolveLibraryChoice(choices, id, "planning")?.revisionId).toBe(next);
  const second = crypto.randomUUID();
  choices.push({
    libraryId: second,
    revisionId: revision,
    role: "planning",
    scope: "system",
    state: "enable",
    version: 1,
  });
  expect(resolveLibraryChoice(choices, second, "planning")?.state).toBe("enable");
});

test("admission rejects an enabled unpublished exact version even when a newer version is published", () => {
  const libraryId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const entries = [
    {
      id: libraryId,
      scope: "system" as const,
      ownerId: null,
      projectId: null,
      editable: false,
      revisions: [false, true].map((published) => ({
        id: published ? crypto.randomUUID() : revisionId,
        revision: published ? 2 : 1,
        content: requirementsInterviewSkill,
        digest: "a".repeat(64),
        published,
      })),
    },
  ];
  const choices: LibraryChoice[] = [
    {
      libraryId,
      revisionId,
      role: "planning",
      scope: "system",
      state: "enable",
      version: 1,
    },
  ];
  expect(() => librarySkillAssignments(entries, choices, "planning")).toThrow("unavailable");
  expect(librarySkillsAvailable(entries, choices, "planning")).toBe(false);
  choices[0] = { ...fixtureValue(choices[0], "choice"), state: "disable" };
  expect(librarySkillAssignments(entries, choices, "planning")).toEqual([]);
  expect(librarySkillsAvailable(entries, choices, "planning")).toBe(true);
});

test("availability and admission agree on role eligibility, missing versions and the sixteen-library bound", () => {
  const entries = Array.from({ length: 17 }, () => ({
    id: crypto.randomUUID(),
    scope: "system" as const,
    ownerId: null,
    projectId: null,
    editable: false,
    revisions: [
      {
        id: crypto.randomUUID(),
        revision: 1,
        content: requirementsInterviewSkill,
        digest: "a".repeat(64),
        published: true,
      },
    ],
  }));
  const choices: LibraryChoice[] = entries.map((entry) => ({
    libraryId: entry.id,
    revisionId: fixtureValue(entry.revisions[0], "revision").id,
    scope: "system",
    role: "planning",
    state: "required",
    version: 1,
  }));
  expect(() => librarySkillAssignments(entries, choices, "planning")).toThrow("At most 16");
  expect(librarySkillsAvailable(entries, choices, "planning")).toBe(false);
  expect(librarySkillsAvailable(entries.slice(0, 16), choices, "planning")).toBe(true);
  const entry = fixtureValue(entries[0], "entry");
  const choice = fixtureValue(choices[0], "choice");
  expect(librarySkillsAvailable([entry], [{ ...choice, role: "build" }], "build")).toBe(false);
  expect(
    librarySkillsAvailable([entry], [{ ...choice, revisionId: crypto.randomUUID() }], "planning"),
  ).toBe(false);
});

test("shared Ticket/background admission excludes personal-only choices and private libraries", () => {
  const entry = {
    id: crypto.randomUUID(),
    scope: "personal" as const,
    ownerId: crypto.randomUUID(),
    projectId: null,
    editable: true,
    revisions: [
      {
        id: crypto.randomUUID(),
        revision: 1,
        content: requirementsInterviewSkill,
        digest: "a".repeat(64),
        published: false,
      },
    ],
  };
  const choice: LibraryChoice = {
    libraryId: entry.id,
    revisionId: fixtureValue(entry.revisions[0], "revision").id,
    scope: "personal",
    role: "planning",
    state: "enable",
    version: 1,
  };
  expect(librarySkillsAvailable([entry], [choice], "planning")).toBe(false);
  expect(librarySkillsAvailable([entry], [choice], "planning", false)).toBe(true);
  expect(librarySkillAssignments([entry], [choice], "planning", false)).toEqual([]);
  expect(
    librarySkillAssignments([entry], [{ ...choice, scope: "project" }], "planning", false),
  ).toEqual([]);
  const shared = { ...entry, scope: "system" as const, ownerId: null };
  const system = { ...choice, scope: "system" as const, state: "disable" as const };
  expect(librarySkillAssignments([shared], [system, choice], "planning", false)).toEqual([]);
});
test("old immutable text parses without defaults or changed digest", () => {
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  expect(digest(skillContentInput.parse(requirementsInterviewSkill))).toBe(
    digest(requirementsInterviewSkill),
  );
  expect(
    skillContentInput.safeParse({
      key: "corporate-design",
      name: "Corporate design",
      description: "Use for our interfaces",
      instructions: "Use our brand colors",
      roles: ["planning", "build"],
      references: [],
    }).success,
  ).toBe(true);
});
test("curated defaults validate, retain exact source and licences, and make grilling manual", () => {
  expect(starterSkills.filter((skill) => skill.enabled).map((skill) => skill.content.key)).toEqual([
    "requirements-interview",
    "diagnosing-bugs",
    "verify-completion",
  ]);
  for (const skill of starterSkills) {
    expect(skillContentInput.safeParse(skill.content).success).toBe(true);
    expect(skill.content.sourceSkill).toContain("---");
    expect(skill.content.origin?.commit).toHaveLength(40);
    expect(skill.content.origin?.licenceText.length).toBeGreaterThan(100);
  }
  expect(starterSkills.find((skill) => skill.content.key === "grill-me")?.content.manualOnly).toBe(
    true,
  );
});
test("package preview preserves source and binary assets, detects scripts, and rejects traversal", () => {
  const original =
    "---\nname: corporate-design\ndescription: Use for our brand\n---\nUse assets/logo.png.\n";
  const files = [
    { path: "SKILL.md", body: original, encoding: "utf8" },
    { path: "assets/logo.png", body: "AAECAw==", encoding: "base64" },
  ];
  const preview = previewSkillImport({ files });
  expect(preview.content.sourceSkill).toBe(original);
  expect(preview.content.files?.[0]?.body).toBe("AAECAw==");
  expect(preview.content.origin).toBeUndefined();
  const script = previewSkillImport({
    files: [...files, { path: "scripts/check.sh", body: "echo check", encoding: "utf8" }],
  });
  expect(script.content.roles).toEqual(["build"]);
  expect(script.warnings.join(" ")).toContain("Build only");
  for (const path of [
    "../secret",
    "assets/../secret",
    "/etc/passwd",
    "assets/link/../../secret",
    "assets\\secret",
  ])
    expect(() =>
      previewSkillImport({ files: [...files, { path, body: "secret", encoding: "utf8" }] }),
    ).toThrow();
});
test("native packages have exact digests, slash invocation is bounded, and observations exclude old turns", () => {
  const revision = {
    id: crypto.randomUUID(),
    revision: 1,
    content: { ...requirementsInterviewSkill, manualOnly: true },
    digest: "a".repeat(64),
    published: true,
  };
  const manifest = nativeSkillManifest([revision]);
  expect(
    Buffer.from(fixtureValue(manifest.files[0], "manifest.files[0]").body, "base64").toString(),
  ).toContain("disable-model-invocation: true");
  expect(invokedSkills("Please /requirements-interview now", [revision])).toEqual([revision]);
  expect(invokedSkills("Read https://example.test/requirements-interview", [revision])).toEqual([]);
  expect(() =>
    invokedSkills("/requirements-interview", [revision, { ...revision, id: crypto.randomUUID() }]),
  ).toThrow("multiple");
  const messages = [
    {
      id: "new-result",
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "skill",
          state: { status: "completed", input: { id: `factory-${revision.id}` } },
        },
      ],
    },
    { id: "current", type: "user" },
    { id: "old-result", type: "skill", skill: `factory-${crypto.randomUUID()}` },
  ];
  expect(observedNativeSkillIds(messages, "current", [revision.id])).toEqual([revision.id]);
  expect(observedNativeSkillIds(messages, "absent", [revision.id])).toEqual([]);
  expect(() =>
    librarySkillIds(
      [
        {
          id: crypto.randomUUID(),
          scope: "personal",
          ownerId: crypto.randomUUID(),
          projectId: null,
          editable: true,
          revisions: [revision],
        },
      ],
      [],
      "planning",
    ),
  ).not.toThrow();
});
