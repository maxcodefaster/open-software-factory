import { expect } from "bun:test";
import type { ProjectAgentOutput } from "../../packages/conversation-domain/src/conversation";

function affirmativeClauses(text: string) {
  return text
    .split(/[.!?;,\n]|\bbut\b|\bhowever\b|\byet\b/i)
    .filter(
      (clause) =>
        !/\bno\b|\bnot\b|\bnever\b|\bwithout\b|\bunchanged\b|\bexcluded\b|\bout of scope\b/i.test(
          clause,
        ),
    );
}

function excludesProfileEditing(text: string) {
  for (const clause of text.split(/[.!?;,\n]|\bbut\b|\bhowever\b|\byet\b/i)) {
    expect(clause).not.toMatch(/\bno (?:authentication|sign.?in|login) (?:is )?required\b/i);
    // Negation must apply to the excluded action. "Without signing in" does
    // not negate "edit passwords", and must not hide that contradiction.
    if (
      /\b(?:no|not|never|without|exclude[sd]?|avoid)\b[^.!?;]{0,30}\b(?:edit\w*|chang\w*|updat\w*|sav\w*|reset\w*|modify|new|add\w*|creat\w*|unauthenticated|anonymous|publicly)\b/i.test(
        clause,
      )
    )
      continue;
    expect(clause).not.toMatch(
      /\b(?:edit(?:able|ing)?|chang(?:e|ing)|updat(?:e|ing)|sav(?:e|ing)|reset(?:ting)?|modify)\b[^.!?;]*(?:password|email|name|profile)|(?:password|email|name|profile)[^.!?;]*\b(?:edit(?:able|ing)?|chang(?:e|ing)|updat(?:e|ing)|sav(?:e|ing)|reset(?:ting)?|modify)\b/i,
    );
    expect(clause).not.toMatch(
      /\b(?:unauthenticated|anonymous|without signing in|publicly accessible)\b/i,
    );
    expect(clause).not.toMatch(/\b(?:add|create|introduce)\b[^.!?;]*\b(?:route|field|form)\b/i);
  }
}

export function verifyReadOnlyProfile(output: ProjectAgentOutput) {
  expect(output.kind).toBe("requirement");
  if (output.kind !== "requirement") throw new Error("Expected final profile requirements");
  const acceptance = output.requirement.acceptanceCriteria.join("\n");
  const visible = [
    output.ticket.title,
    output.ticket.description,
    output.requirement.summary,
    acceptance,
  ].join("\n");
  expect(acceptance).toMatch(/\bname\b/i);
  expect(acceptance).toMatch(/\bemail\b/i);
  expect(acceptance).toMatch(/read.only|no.*(?:edit|input|control)|not.*edit/i);
  expect(acceptance).toMatch(/sign.?out|log.?out/i);
  expect(visible).toMatch(/signed.in|authenticated|protected|current user|own (?:name|email)/i);
  excludesProfileEditing(visible);
}

export function verifyProfilePlacement(output: ProjectAgentOutput) {
  expect(["question", "round"]).toContain(output.kind);
  const questions =
    output.kind === "round"
      ? output.questions
      : output.kind === "question"
        ? [output.question]
        : [];
  expect(questions).toHaveLength(1);
  const question = questions[0];
  expect(question?.type).toBe("single-select");
  if (question?.type !== "single-select") throw new Error("Expected one placement choice");
  expect(question.allowCustom).toBe(true);
  expect(question.options.every((option) => option.description.length > 0)).toBe(true);
  expect(question.prompt).toMatch(/where|location|appear|placement|show|display/i);
  const choices = question.options
    .map((option) => `${option.label} ${option.description}`)
    .join("\n");
  expect(choices).toMatch(/\bhome\b/i);
  expect(choices).toMatch(/\baccount\b/i);
  excludesProfileEditing(`${question.prompt}\n${choices}`);
}

export function verifyExportPrerequisite(output: ProjectAgentOutput, dependentID: string) {
  expect(output.kind).toBe("answer");
  const text = output.message;
  expect(text).toMatch(
    /Prepare export[^.!?;]{0,120}\b(?:before|first|prerequisite)\b|Deliver export[^.!?;]{0,80}\bdepends on\b[^.!?;]{0,80}Prepare export/i,
  );
  for (const clause of affirmativeClauses(text)) {
    expect(clause).not.toMatch(/Deliver export[^.!?;]{0,80}\b(?:first|before)\b/i);
    expect(clause).not.toMatch(
      /Prepare export[^.!?;]{0,80}\b(?:after|depends on)\b[^.!?;]{0,80}Deliver export/i,
    );
  }
  expect(output.citations.some((citation) => citation.id === dependentID)).toBe(true);
}
