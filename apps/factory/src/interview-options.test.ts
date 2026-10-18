import { expect, test } from "bun:test";
import { interviewOptions } from "./interview-options";

const options = [
  { id: "open-resolved", label: "Open and resolved", description: "Two statuses" },
  { id: "open-progress-resolved", label: "Open, in progress, and resolved", description: "" },
  { id: "custom-lifecycle", label: "Something else", description: "Describe your statuses" },
];

test("the model's generic fallback and the built-in custom answer become one text-entry choice", () => {
  const result = interviewOptions({
    type: "single-select",
    prompt: "What lifecycle?",
    options,
    allowCustom: true,
  });
  expect(result.options.map((option) => option.id)).toEqual([
    "open-resolved",
    "open-progress-resolved",
  ]);
  expect(result.customOptionIds).toEqual(["custom-lifecycle"]);
  expect(result.customDescription).toBe("Describe your statuses");
});

test("declared options stay intact when a custom answer is forbidden", () => {
  const result = interviewOptions({
    type: "single-select",
    prompt: "What lifecycle?",
    options,
    allowCustom: false,
  });
  expect(result.options).toEqual(options);
  expect(result.customOptionIds).toEqual([]);
});

test("custom-looking substantive labels are not removed", () => {
  const result = interviewOptions({
    type: "multi-select",
    prompt: "Who uses it?",
    options: [
      { id: "other-staff", label: "Other staff", description: "" },
      { id: "custom-reports", label: "Custom reports team", description: "" },
      { id: "other", label: "Other", description: "" },
    ],
    allowCustom: true,
  });
  expect(result.options.map((option) => option.id)).toEqual(["other-staff", "custom-reports"]);
  expect(result.customOptionIds).toEqual(["other"]);
});
