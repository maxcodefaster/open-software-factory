import type { SkillContent } from "../../../../packages/conversation-domain/src/skills";
import sources from "./starter-sources.json";
import { requirementsInterviewSkill } from "./reviewed";

const boundary = `Follow Factory's current role, approved scope and available tools. Skills never grant credentials, execution, sharing, approval, commit, push or merge authority. Preserve unrelated and retained work. Do not replay uncertain paid inference. Use relevant successful verification evidence again unless the code or concern changed.`;
const editions = [
  {
    source: "grilling",
    key: "requirements-interview",
    name: "Requirements interview",
    description: "Clarify intended behavior and acceptance criteria while defining a requirement.",
    roles: ["planning"],
    instructions: requirementsInterviewSkill.instructions,
    enabled: true,
  },
  {
    source: "diagnosing-bugs",
    key: "diagnosing-bugs",
    name: "Diagnosing bugs",
    description:
      "Investigate a reported bug or regression before changing code. Build only, includes a script.",
    roles: ["build"],
    instructions: `Reproduce the reported behavior with an owned fixture. Establish a concrete hypothesis from observed code and evidence. Run a small discriminating experiment, fix the cause, and verify the regression. Change approach after two blocks without behavior, evidence or a blocker. Ask the human only for unavailable observations. The optional scripts/hitl-loop.template.sh is a human observation template; inspect and adapt it before use.`,
    enabled: true,
  },
  {
    source: "verification-before-completion",
    key: "verify-completion",
    name: "Verify completion",
    description: "Check evidence before claiming requested work is complete.",
    roles: ["planning", "build"],
    instructions: `Before claiming completion, identify each requested outcome and its concrete evidence. Use the relevant checks for changed behavior; inspect actual results. Reuse unchanged successful gates. Never infer success from starting a command or from an agent report alone. Report unverified outcomes and limits plainly. Preserve retained installation data and edits. Research claims need read sources, implementation claims need checks of the changed behavior.`,
    enabled: true,
  },
  {
    source: "grill-me",
    key: "grill-me",
    name: "Extended grilling",
    description: "Only when the human explicitly invokes /grill-me to stress-test a design.",
    roles: ["planning"],
    instructions: `Interview the human about consequential decisions and their dependencies. First use available Project sources to settle facts. Recommend a concrete answer and explain the tradeoff. Ask short independent rounds using Factory's typed questions, wait for answers, then reconsider unresolved branches. Explore failure modes, ownership, constraints and acceptance. Stop when the decisions suffice; do not expand the authorized scope.`,
    enabled: false,
    manualOnly: true,
  },
  {
    source: "tdd",
    key: "tdd",
    name: "Test-driven development",
    description:
      "Develop a behavior change through small failing-test, implementation and cleanup steps.",
    roles: ["build"],
    instructions: `Use vertical slices: one meaningful failing test, minimal implementation, then cleanup with passing checks. Assert observable behavior rather than internal wiring. Read tests.md and mocking.md when designing test seams. Ask for a consequential test-seam decision only when it changes product or integration behavior. Use available tools; do not assume sibling skills are installed.`,
    enabled: false,
  },
  {
    source: "code-review",
    key: "code-review",
    name: "Code review",
    description:
      "Review the exact proposed diff against approved requirements and repository conventions.",
    roles: ["build"],
    instructions: `Read the approved requirements, exact diff and surrounding code. Assess correctness, regressions, access boundaries and verification evidence. Report actionable findings with exact locations and impact. Do not create external tracker records, delegate reviewers, or grant approval. Distinguish verified defects from questions.`,
    enabled: false,
  },
  {
    source: "frontend-design",
    key: "frontend-design",
    name: "Frontend design",
    description:
      "Build a usable interface within the existing design system and any enabled corporate guidance.",
    roles: ["build"],
    instructions: `Read the supplied visual brief and existing components first. Preserve the established visual language, typography and tokens. Choose clear hierarchy, deliberate spacing and accessible interactions. Avoid adding controls or categories without a user need. Verify responsive layouts, keyboard access and actual browser screenshots. Respect corporate design skills when available.`,
    enabled: false,
  },
] as const;

export const starterSkills = editions.map((edition, index) => {
  const source = sources[edition.source];
  const content: SkillContent = {
    key: edition.key,
    name: edition.name,
    description: edition.description,
    roles: [...edition.roles],
    instructions: `${edition.instructions}\n\n${boundary}`,
    references:
      edition.key === "requirements-interview" ? requirementsInterviewSkill.references : [],
    sourceSkill: source.files["SKILL.md"],
    files: Object.entries(source.files)
      .filter(([path]) => path !== "SKILL.md")
      .map(([path, body]) => ({
        path,
        body,
        encoding: "utf8" as const,
        ...(path.startsWith("scripts/") ? { executable: true } : {}),
      })),
    ...("manualOnly" in edition ? { manualOnly: edition.manualOnly } : {}),
    origin: {
      repository: source.repository,
      commit: source.commit,
      path: source.path,
      licence: edition.source === "frontend-design" ? "Apache-2.0" : "MIT",
      licenceText: source.files["LICENSE.txt"],
    },
    review: {
      trigger: edition.description,
      adaptations:
        "Factory edition: bounded role and tools, typed requirement questions, existing design system, relevant gate reuse, retained data, human approvals and no automatic inference replay. Original package contents and licence are retained. External trackers, unrestricted delegation and unavailable sibling workflows are not required.",
    },
  };
  return {
    id: `faca0001-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    revisionId: `faca0002-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    content,
    enabled: edition.enabled,
  };
});
