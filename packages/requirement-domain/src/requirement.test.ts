import { describe, expect, test } from "bun:test";
import {
  approveRequirementRevision,
  canonicalRequirementContent,
  createRequirementRevision,
} from "./requirement";

describe("Requirement Revision", () => {
  const content = {
    summary: "  Export audit data  ",
    acceptanceCriteria: ["CSV downloads", "Exact timestamps"],
    nonGoals: ["Scheduled exports"],
  };

  test("canonicalizes and hashes exact immutable content", () => {
    const revision = createRequirementRevision({
      id: crypto.randomUUID(),
      ticketId: crypto.randomUUID(),
      ordinal: 1,
      content,
    });
    expect(revision.canonicalContent).toBe(
      '{"acceptanceCriteria":["CSV downloads","Exact timestamps"],"nonGoals":["Scheduled exports"],"summary":"Export audit data"}',
    );
    expect(revision.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(revision)).toBe(true);
    expect(canonicalRequirementContent(content)).toBe(revision.canonicalContent);
  });

  test("rejects duplicate criteria and mismatched approval", () => {
    expect(() =>
      canonicalRequirementContent({
        summary: "Export",
        acceptanceCriteria: ["CSV", "CSV"],
        nonGoals: [],
      }),
    ).toThrow("duplicates");
    expect(() =>
      approveRequirementRevision(
        { id: crypto.randomUUID(), ticketId: crypto.randomUUID() },
        {
          id: crypto.randomUUID(),
          ticketId: crypto.randomUUID(),
          requirementRevisionId: crypto.randomUUID(),
          approvedBy: crypto.randomUUID(),
        },
      ),
    ).toThrow("exact Ticket revision");
  });
});
