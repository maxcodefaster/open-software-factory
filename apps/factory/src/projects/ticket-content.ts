import type { RequirementContent } from "../../../../packages/requirement-domain/src/content";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/content";
import type { RequirementRevision } from "../api-contracts";

export function requirementContent(revision?: RequirementRevision): RequirementContent | undefined {
  if (!revision) return undefined;
  try {
    const parsed = requirementContentInput.safeParse(JSON.parse(revision.canonicalContent));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function ticketReference(ticketID: string) {
  return `TCK-${ticketID.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}
