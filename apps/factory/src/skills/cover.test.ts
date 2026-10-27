import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { skillCover, skillSummary } from "./cover";
import { starterSkills } from "./starters";

test("every starter has its own shipped cover and approved concise summary", () => {
  const images = starterSkills.map((skill) => skillCover(skill.id));
  expect(new Set(images).size).toBe(7);
  for (const skill of starterSkills) {
    expect(
      existsSync(resolve(import.meta.dir, "../../public", skillCover(skill.id).slice(1))),
    ).toBe(true);
    expect(skillSummary(skill.content).length).toBeLessThan(skill.content.description.length);
  }
});

test("entries without saved artwork use a neutral fallback rather than a claimed starter cover", () => {
  expect(skillCover("custom")).toBe("/art/skills/personal-fallback.webp");
  expect(skillCover("imported-code-review")).toBe("/art/skills/personal-fallback.webp");
  expect(existsSync(resolve(import.meta.dir, "../../public", skillCover("custom").slice(1)))).toBe(
    true,
  );
});

test("edited and unknown descriptions remain the author's text", () => {
  expect(
    skillSummary({ key: "code-review", description: "Review our privacy boundary first." }),
  ).toBe("Review our privacy boundary first.");
  expect(skillSummary({ key: "custom", description: "Use our own process." })).toBe(
    "Use our own process.",
  );
});
