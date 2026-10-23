import { expect, test } from "bun:test";
import { insertSkillInvocation, skillInvocationQuery } from "./chat-invocation";

test("only a slash token at the caret opens Skill suggestions", () => {
  expect(skillInvocationQuery("/", 1)).toBe("");
  expect(skillInvocationQuery("Please /rev", 11)).toBe("rev");
  expect(skillInvocationQuery("Please /rev later", 11)).toBe("rev");
  expect(skillInvocationQuery("/review-ui ", 11)).toBeNull();
  expect(skillInvocationQuery("https://", 8)).toBeNull();
  expect(skillInvocationQuery("src/view", 8)).toBeNull();
  expect(skillInvocationQuery("/rev", 0, 4)).toBeNull();
});

test("Skill selection edits only the current selection and never consumes surrounding prose", () => {
  expect(insertSkillInvocation("Inspect this", 12, 12, "review-ui")).toEqual({
    text: "Inspect this /review-ui ",
    cursor: 24,
  });
  expect(insertSkillInvocation("Use /rev please", 8, 8, "review-ui")).toEqual({
    text: "Use /review-ui  please",
    cursor: 15,
  });
  expect(insertSkillInvocation("Replace this selection.", 8, 12, "review-ui")).toEqual({
    text: "Replace /review-ui  selection.",
    cursor: 19,
  });
});

test("Skill selection preserves existing file references and rejects arbitrary slash commands", () => {
  const text = "Read [reference](/api/attachments/owned) first.";
  const selected = insertSkillInvocation(text, 0, 0, "reference-review");
  expect(selected.text).toBe(`/reference-review ${text}`);
  expect(() => insertSkillInvocation("", 0, 0, "../shell")).toThrow("Invalid Skill");
});
