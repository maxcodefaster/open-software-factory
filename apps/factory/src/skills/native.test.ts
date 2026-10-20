import { expect, test } from "bun:test";
import type { SkillRevision } from "../../../../packages/conversation-domain/src/skills";
import { nativeInputSkills, nativeSkillId, observedNativeSkillIds } from "./native";
import { requirementsInterviewSkill } from "./reviewed";

function revision(id: string, key: string, manualOnly = false): SkillRevision {
  return {
    id,
    revision: 1,
    content: {
      ...requirementsInterviewSkill,
      key,
      roles: ["build"],
      manualOnly,
    },
    digest: "a".repeat(64),
    published: true,
  };
}

const required = revision("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "required-rule");
const optional = revision("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "optional-guidance");
const manual = revision("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "manual-review", true);

test("native Build input loads required guidance without preloading optional guidance", () => {
  expect(
    nativeInputSkills("Implement the approved work.", [required, optional], [required.id]),
  ).toEqual([{ id: nativeSkillId(required) }]);
});

test("manual-only guidance still requires human invocation even when assigned as required", () => {
  expect(nativeInputSkills("Implement the approved work.", [manual], [manual.id])).toEqual([]);
  expect(nativeInputSkills("Use /manual-review.", [manual], [manual.id])).toEqual([
    { id: nativeSkillId(manual) },
  ]);
});

test("native input deduplicates required and explicitly invoked revisions", () => {
  expect(
    nativeInputSkills(
      "Use /required-rule and /manual-review.",
      [required, optional, manual],
      [required.id],
    ),
  ).toEqual([{ id: nativeSkillId(required) }, { id: nativeSkillId(manual) }]);
});

test("historical input without required assignments keeps optional loading on demand", () => {
  expect(nativeInputSkills("Implement the approved work.", [required, optional], [])).toEqual([]);
  expect(nativeInputSkills("Use /optional-guidance.", [required, optional], [])).toEqual([
    { id: nativeSkillId(optional) },
  ]);
});

test("native resolved input attachments count as loaded, eligibility and unresolved IDs do not", () => {
  const messages = [
    { id: "answer", type: "assistant", content: [] },
    {
      id: "owned-input",
      type: "user",
      skills: [
        { id: nativeSkillId(required), name: "Required rule", text: required.content.instructions },
        { id: nativeSkillId(optional) },
        { id: nativeSkillId(manual), text: " " },
      ],
    },
  ];
  expect(
    observedNativeSkillIds(messages, "owned-input", [required.id, optional.id, manual.id]),
  ).toEqual([required.id]);
  expect(observedNativeSkillIds(messages, "different-input", [required.id])).toEqual([]);
});
