import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { skillContentInput } from "./skills";
import { resolveLibraryChoice, librarySkillIds, type LibraryChoice } from "./skill-library";
import { requirementsInterviewSkill } from "../../../apps/factory/src/skills/reviewed";
import { starterSkills } from "../../../apps/factory/src/skills/starters";
import { previewSkillImport } from "../../../apps/factory/src/skills/import";
import {
  nativeSkillManifest,
  invokedSkills,
  observedNativeSkillIds,
} from "../../../apps/factory/src/skills/native";

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
  choices[1] = { ...choices[1]!, state: "inherit", version: 2 };
  choices[0] = { ...choices[0]!, revisionId: next };
  expect(resolveLibraryChoice(choices, id, "planning")?.revisionId).toBe(next);
  choices[0] = { ...choices[0]!, state: "required" };
  choices[1] = { ...choices[1]!, state: "enable", revisionId: revision };
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
  expect(Buffer.from(manifest.files[0]!.body, "base64").toString()).toContain(
    "disable-model-invocation: true",
  );
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
