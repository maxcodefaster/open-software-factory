import { createHash } from "node:crypto";
import { type RequirementContent, requirementContentInput } from "./content";

export { type RequirementContent, requirementContentInput } from "./content";

function unique(values: readonly string[], field: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`${field} must not contain duplicates`);
}

export function canonicalRequirementContent(input: RequirementContent) {
  const content = requirementContentInput.parse(input);
  unique(content.acceptanceCriteria, "Acceptance criteria");
  unique(content.nonGoals, "Non-goals");
  return JSON.stringify({
    acceptanceCriteria: content.acceptanceCriteria,
    nonGoals: content.nonGoals,
    summary: content.summary,
  });
}

export function requirementDigest(canonicalContent: string) {
  return createHash("sha256").update(canonicalContent).digest("hex");
}

export function createRequirementRevision(input: {
  id: string;
  ticketId: string;
  ordinal: number;
  content: RequirementContent;
}) {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
    throw new Error("Requirement Revision ordinal must be positive");
  }
  const canonicalContent = canonicalRequirementContent(input.content);
  return Object.freeze({
    id: input.id,
    ticketId: input.ticketId,
    ordinal: input.ordinal,
    canonicalContent,
    contentDigest: requirementDigest(canonicalContent),
  });
}

export function approveRequirementRevision(
  revision: { id: string; ticketId: string },
  input: { id: string; ticketId: string; requirementRevisionId: string; approvedBy: string },
) {
  if (input.ticketId !== revision.ticketId || input.requirementRevisionId !== revision.id) {
    throw new Error("Requirement Approval must identify the exact Ticket revision");
  }
  return Object.freeze({ ...input });
}
