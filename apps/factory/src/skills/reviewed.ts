import type { SkillContent } from "../../../../packages/conversation-domain/src/skills";

// Reviewed, adapted text only. Publication remains an explicit System Manager command.
export const requirementsInterviewSkill = {
  key: "requirements-interview",
  name: "Requirements interview",
  description:
    "Resolve the decisions needed for one testable Requirement without a fixed interview script.",
  roles: ["planning"],
  instructions: `Map the intended change into decisions and their prerequisites. Distinguish facts from human choices.
Use the existing Project Knowledge and Ticket searches for facts. Do not invent repository facts or ask the
human to look up information that the available searches can establish.
Ask a short round of independent decisions whose prerequisites are settled. Recommend an answer and explain its consequence.
Use Factory's typed single-select, multi-select or free-text question. Always permit a custom answer.
Factory presents each question separately. Wait for answers before asking dependent questions.
Recompute what remains after each round or a change of direction.
When the intended behavior, acceptance criteria and exclusions are sufficient, propose the Requirement.
Do not keep interviewing merely to visit every possible branch. See references/decision-checklist.md.`,
  references: [
    {
      path: "references/decision-checklist.md",
      body: `For each unresolved decision, check whether it changes observable behavior or acceptance.
Ask about user choices, not facts available from cited Project sources.
Keep each question focused. A round may contain independent questions, never questions dependent on earlier answers.
Write acceptance criteria that a person can verify. State exclusions only when they prevent likely scope creep.
Investigation may answer or identify uncertainty. Only Plan may propose a Requirement; neither mode implements it.`,
    },
  ],
  origin: {
    repository: "https://github.com/mattpocock/skills",
    commit: "f3fc5632f401156837ee3872f14fe33ccf1024ea",
    path: "skills/productivity/grilling/SKILL.md",
    licence: "MIT",
    licenceText: `MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
  review: {
    trigger:
      "Load for Investigate/Plan when a manager assigns it as required or a human selects it as an optional planning Skill.",
    adaptations:
      "Retained independent decision rounds and facts-versus-choices discipline. Factory displays one question at a time. Removed delegation, unrestricted environment inspection, special formatting and the requirement to exhaust every design branch. The bundled reference is Factory-authored guidance. No scripts or additional tools.",
  },
} satisfies SkillContent;
