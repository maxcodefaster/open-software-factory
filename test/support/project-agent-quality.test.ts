import { expect, test } from "bun:test";
import type { ProjectAgentOutput } from "../../packages/conversation-domain/src/conversation";
import {
  verifyExportPrerequisite,
  verifyProfilePlacement,
  verifyReadOnlyProfile,
} from "./project-agent-quality";

const requirement: ProjectAgentOutput = {
  kind: "requirement",
  message: "Ready",
  ticket: {
    title: "Read-only profile",
    description: "Show the signed-in user's existing name and email on the protected home.",
  },
  requirement: {
    summary: "Display the current user's profile without changing authentication.",
    acceptanceCriteria: [
      "The signed-in user sees their existing name and email, read-only.",
      "No editing controls are available.",
      "Existing sign-out still works.",
    ],
    nonGoals: ["No new fields, editing or routes"],
  },
  citations: [],
};

test("profile quality requires the requested facts and rejects an affirmative contradictory clause", () => {
  expect(() => verifyReadOnlyProfile(requirement)).not.toThrow();
  if (requirement.kind !== "requirement") throw new Error("Fixture");
  for (const acceptanceCriteria of [
    ["Read-only email", "Anyone may edit every user's password without signing in"],
    [
      ...requirement.requirement.acceptanceCriteria,
      "No profile editing, but allow changing passwords",
    ],
    [
      ...requirement.requirement.acceptanceCriteria,
      "Anyone may edit every user's password without signing in",
    ],
    ["The signed-in user's email is read-only", "Sign-out still works"],
  ])
    expect(() =>
      verifyReadOnlyProfile({
        ...requirement,
        requirement: { ...requirement.requirement, acceptanceCriteria },
      }),
    ).toThrow();
});

test("placement quality rejects unrelated editing even when it contains the old placement keywords", () => {
  const question: ProjectAgentOutput = {
    kind: "question",
    message: "One question",
    citations: [],
    question: {
      type: "single-select",
      prompt: "Where should the read-only profile appear?",
      allowCustom: true,
      options: [
        { id: "home", label: "Home", description: "Show it on the protected home" },
        {
          id: "account",
          label: "Account menu",
          description: "Show it in the existing account menu",
        },
      ],
    },
  };
  expect(() => verifyProfilePlacement(question)).not.toThrow();
  if (question.kind !== "question") throw new Error("Fixture");
  expect(() =>
    verifyProfilePlacement({
      ...question,
      question: { ...question.question, prompt: "Where should password editing be added?" },
    }),
  ).toThrow();
});

test("dependency quality checks direction, not merely both titles and the word first", () => {
  const dependentID = crypto.randomUUID();
  const answer: ProjectAgentOutput = {
    kind: "answer",
    message: "Prepare export must finish first. Deliver export depends on Prepare export.",
    citations: [{ source: "ticket", id: dependentID, label: "Deliver export" }],
  };
  expect(() => verifyExportPrerequisite(answer, dependentID)).not.toThrow();
  for (const message of [
    "Deliver export finishes first; Prepare export runs after it.",
    "Prepare export depends on Deliver export. Prepare export is first in the list.",
    "Prepare export finishes first, but Deliver export must finish before Prepare export.",
  ])
    expect(() => verifyExportPrerequisite({ ...answer, message }, dependentID)).toThrow();
});
