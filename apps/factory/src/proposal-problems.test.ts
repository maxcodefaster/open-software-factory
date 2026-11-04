import { describe, expect, test } from "bun:test";
import { epicProposalInput } from "../../../packages/conversation-domain/src/epic-proposal";
import { technicalDesignContentInput } from "../../../packages/requirement-domain/src/technical-design";
import { epicProposalProblem, technicalDesignProblem } from "./proposal-problems";

const member = (key: string, patch: Record<string, unknown> = {}) => ({
  key,
  existingTicketId: null,
  expectedVersion: null,
  title: `Ticket ${key}`,
  description: "",
  requirement: { summary: "Outcome", acceptanceCriteria: ["Verifiable"], nonGoals: [] },
  dependsOn: [],
  ...patch,
});
const proposal = (epicTitle: string, ...members: ReturnType<typeof member>[]) =>
  ({ epic: { title: epicTitle, description: "" }, members }) as never;

describe("epic proposal problems", () => {
  test("name the part that needs attention instead of the schema message", () => {
    expect(epicProposalProblem(proposal(" ", member("a"), member("b")), "x")).toBe(
      "Give the Epic a title.",
    );
    expect(
      epicProposalProblem(proposal("Epic", member("a"), member("b", { title: "" })), "x"),
    ).toBe("Proposed Ticket 2 needs a title.");
    expect(
      epicProposalProblem(
        proposal(
          "Epic",
          member("a", { requirement: { summary: "", acceptanceCriteria: ["x"], nonGoals: [] } }),
          member("b"),
        ),
        "x",
      ),
    ).toBe("Proposed Ticket 1 needs an outcome.");
    expect(
      epicProposalProblem(
        proposal(
          "Epic",
          member("a"),
          member("b", { requirement: { summary: "S", acceptanceCriteria: [" "], nonGoals: [] } }),
        ),
        "x",
      ),
    ).toBe("Proposed Ticket 2 needs at least one acceptance criterion.");
  });

  test("keeps the schema message when no member explains it", () => {
    expect(
      epicProposalProblem(proposal("Epic", member("a"), member("b")), "Reuse each Ticket once"),
    ).toBe("Reuse each Ticket once");
    expect(epicProposalProblem(proposal("Epic", member("a"), member("b")), undefined)).toBe(
      "Review the proposed work.",
    );
  });

  test("matches what the schema rejects", () => {
    expect(epicProposalInput.safeParse(proposal("", member("a"), member("b"))).success).toBe(false);
  });
});

describe("technical design problems", () => {
  const valid = {
    context: "Context",
    proposedChanges: "Changes",
    decisions: [],
    assumptions: [],
    risks: [],
    validation: [{ criterion: 1, check: "Check" }],
    diagrams: [],
  };
  const firstIssue = (content: unknown) => {
    const parsed = technicalDesignContentInput.safeParse(content);
    if (parsed.success) throw new Error("Expected invalid content");
    const [issue] = parsed.error.issues;
    if (!issue) throw new Error("Expected an issue");
    return issue;
  };

  test("names the empty field", () => {
    expect(technicalDesignProblem(firstIssue({ ...valid, context: "" }))).toBe(
      "Current system cannot be empty.",
    );
    expect(technicalDesignProblem(firstIssue({ ...valid, proposedChanges: " " }))).toBe(
      "Proposed changes cannot be empty.",
    );
    expect(technicalDesignProblem(firstIssue({ ...valid, validation: [] }))).toBe(
      "Validation cannot be empty.",
    );
  });

  test("names an over-long field", () => {
    expect(technicalDesignProblem(firstIssue({ ...valid, context: "x".repeat(12_001) }))).toBe(
      "Current system is too long. Shorten it to save the design.",
    );
  });

  test("keeps the PlantUML guidance", () => {
    expect(
      technicalDesignProblem(
        firstIssue({
          ...valid,
          diagrams: [{ title: "T", description: "D", source: "@startuml\n!include x\n@enduml" }],
        }),
      ),
    ).toContain("self-contained PlantUML");
  });
});
