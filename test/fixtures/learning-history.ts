import type { LearningView } from "../../packages/conversation-domain/src/learning";
import { learningFixture } from "./learning";
import { fixtureValue } from "./value";

/** Labeled synthetic records for the real dashboard, not production history. */
export function learningHistoryFixture(): LearningView {
  const view = learningFixture();
  const review = fixtureValue(view.reviews[0], "view.reviews[0]");
  const proposal = fixtureValue(view.proposals[0], "view.proposals[0]");
  const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  view.reviews = [23, 24, 25, 26].map((day) => ({
    ...review,
    id: id(day),
    createdAt: `2026-10-${day}T09:00:00Z`,
    completedAt: `2026-10-${day}T09:00:15Z`,
  }));
  view.proposals = [
    {
      ...proposal,
      id: id(33),
      reviewId: id(23),
      state: "ticket-created",
      ticketId: id(43),
    },
    {
      ...proposal,
      id: id(34),
      reviewId: id(24),
      content: { ...proposal.content, title: "Shorten source citations", target: "skill" },
    },
    {
      ...proposal,
      id: id(35),
      reviewId: id(25),
      content: {
        ...proposal.content,
        title: "Clarify incomplete Input requests",
        target: "input",
        change: "Ask for the missing Project reference before preparing requirements.",
      },
    },
    {
      ...proposal,
      id: id(36),
      reviewId: id(26),
      state: "applied",
      content: {
        ...proposal.content,
        title: "Read sources before asking again",
        target: "skill",
      },
    },
  ];
  const target = {
    kind: "skill" as const,
    id: id(50),
    revisionId: id(51),
    version: 3,
    field: "instructions" as const,
  };
  view.comparisons = [
    {
      id: id(60),
      proposalId: id(34),
      title: "Shorten source citations",
      phase: "adopt",
      state: "completed",
      reason: "Both claimed baseline failures did not reproduce. The current revision is kept.",
      modelId: "Synthetic model",
      rubric: "planning-text-replay/v1",
      createdAt: "2026-10-24T10:00:00Z",
      candidateFirst: false,
      baselineTarget: { ...target, version: 2 },
      before: "Cite the exact source for each material claim.",
      after: "Shorten repeated source references.",
      evidence: [],
      responses: [],
      result: { passed: false, decision: "kept", cases: [] },
    },
  ];
  const edit = {
    target,
    before: "Ask again when the request leaves out a value.",
    after: "Inspect available source material before repeating a question.",
  };
  view.applications = [
    {
      id: id(70),
      proposalId: id(36),
      title: "Read sources before asking again",
      target,
      edit,
      appliedRevisionId: id(52),
      appliedVersion: 4,
      state: "applied",
      canRevert: true,
      createdAt: "2026-10-26T10:00:00Z",
      revertedAt: null,
      automatic: true,
      automaticRecovery: false,
      targetLabel: "Source-backed research",
      targetScope: "project",
      subsequent: { sampled: 3, reviewed: 2, problems: 0, cases: [] },
    },
  ];
  return view;
}
