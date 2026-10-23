import type { SkillContent } from "../../../../packages/conversation-domain/src/skills";

const covers: Readonly<Record<string, string>> = {
  "faca0001-0000-4000-8000-000000000001": "requirements-interview",
  "faca0001-0000-4000-8000-000000000002": "diagnosing-bugs",
  "faca0001-0000-4000-8000-000000000003": "verify-completion",
  "faca0001-0000-4000-8000-000000000004": "grill-me",
  "faca0001-0000-4000-8000-000000000005": "tdd",
  "faca0001-0000-4000-8000-000000000006": "code-review",
  "faca0001-0000-4000-8000-000000000007": "frontend-design",
};
const summaries: Readonly<Record<string, { original: string; short: string }>> = {
  "requirements-interview": {
    original: "Clarify intended behavior and acceptance criteria while defining a requirement.",
    short: "Turn an idea into clear requirements.",
  },
  "diagnosing-bugs": {
    original:
      "Investigate a reported bug or regression before changing code. Build only, includes a script.",
    short: "Find the cause before changing code.",
  },
  "verify-completion": {
    original: "Check evidence before claiming requested work is complete.",
    short: "Check the evidence before calling it done.",
  },
  "grill-me": {
    original: "Only when the human explicitly invokes /grill-me to stress-test a design.",
    short: "Stress-test a decision with deeper questions.",
  },
  tdd: {
    original:
      "Develop a behavior change through small failing-test, implementation and cleanup steps.",
    short: "Change behavior one passing test at a time.",
  },
  "code-review": {
    original:
      "Review the exact proposed diff against approved requirements and repository conventions.",
    short: "Find defects in the proposed change.",
  },
  "frontend-design": {
    original:
      "Build a usable interface within the existing design system and any enabled corporate guidance.",
    short: "Build clear, usable interfaces.",
  },
};

export const skillCover = (libraryId: string) =>
  `/art/skills/${covers[libraryId] ?? "personal-fallback"}.webp`;

export function skillSummary(content: Pick<SkillContent, "key" | "description">) {
  const summary = summaries[content.key];
  return summary?.original === content.description ? summary.short : content.description;
}
