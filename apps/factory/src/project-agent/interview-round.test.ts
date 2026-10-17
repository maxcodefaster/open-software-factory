import { expect, test } from "bun:test";
import { canAdvanceInterviewRound } from "./interview-round";

const free = { type: "free-text" as const, prompt: "Who uses it?", placeholder: "Audience" };
const choice = {
  type: "single-select" as const,
  prompt: "Who uses it?",
  allowCustom: true,
  options: [
    { id: "dev", label: "Developers", description: "Internal use" },
    { id: "product", label: "Product", description: "Contributors" },
  ],
};

test("independent answers advance immediately; custom choices and explicit corrections replan", () => {
  expect(
    canAdvanceInterviewRound(free, { selectedOptionIds: [], customText: "Product contributors" }),
  ).toBe(true);
  expect(canAdvanceInterviewRound(choice, { selectedOptionIds: ["dev"], customText: "" })).toBe(
    true,
  );
  expect(
    canAdvanceInterviewRound(choice, { selectedOptionIds: [], customText: "External customers" }),
  ).toBe(false);
  for (const customText of [
    "Actually, public customers, not developers",
    "Correction: no login",
    "Stattdessen machen wir nur einen Export",
    "Eigentlich soll das Projekt etwas anderes tun",
  ])
    expect(canAdvanceInterviewRound(free, { selectedOptionIds: [], customText })).toBe(false);
});
