import type { EpicProposal } from "../../../packages/conversation-domain/src/epic-proposal";

// The schema's own messages name no field; say which part of the proposal needs attention.
export function epicProposalProblem(proposal: EpicProposal, fallback: string | undefined) {
  if (!proposal.epic.title.trim()) return "Give the Epic a title.";
  const index = proposal.members.findIndex(
    (member) =>
      !member.title.trim() ||
      !member.requirement.summary.trim() ||
      !member.requirement.acceptanceCriteria.some((criterion) => criterion.trim()),
  );
  const member = proposal.members[index];
  if (member) {
    const part = !member.title.trim()
      ? "a title"
      : !member.requirement.summary.trim()
        ? "an outcome"
        : "at least one acceptance criterion";
    return `Proposed Ticket ${index + 1} needs ${part}.`;
  }
  return fallback ?? "Review the proposed work.";
}

const designFields: Record<string, string> = {
  context: "Current system",
  proposedChanges: "Proposed changes",
  decisions: "Decisions",
  assumptions: "Assumptions",
  risks: "Risks",
  validation: "Validation",
  diagrams: "Diagram",
};

// The schema's own messages name no field. Say which part of the design needs attention.
export function technicalDesignProblem(issue: {
  code: string;
  message: string;
  path: readonly PropertyKey[];
}) {
  if (issue.code === "custom") return issue.message;
  const field = designFields[String(issue.path[0])];
  if (!field) return "Complete the technical design before saving.";
  if (issue.code === "too_small") return `${field} cannot be empty.`;
  if (issue.code === "too_big") return `${field} is too long. Shorten it to save the design.`;
  return `Check ${field} before saving.`;
}
