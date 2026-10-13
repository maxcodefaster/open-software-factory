import { expect, test } from "bun:test";
import { epicProposalInput, type EpicProposal } from "./epic-proposal";

const proposal: EpicProposal = {
  epic: { title: "Invoice workflow", description: "Manage invoices" },
  members: ["export", "download"].map((key) => ({
    key,
    title: key,
    description: "",
    existingTicketId: null,
    expectedVersion: null,
    requirement: { summary: key, acceptanceCriteria: ["Observable result"], nonGoals: [] },
    dependsOn: key === "download" ? ["export"] : [],
  })),
};

test("Epic proposal validates unique versioned members and an acyclic complete dependency graph", () => {
  expect(epicProposalInput.parse(proposal)).toEqual(proposal);
  const invalidMembers = [
    proposal.members.map((member) => ({ ...member, key: "duplicate" })),
    proposal.members.map((member) => ({ ...member, dependsOn: [member.key] })),
    proposal.members.map((member) => ({ ...member, dependsOn: ["missing"] })),
    proposal.members.map((member) => ({
      ...member,
      dependsOn: member.key === "export" ? ["download"] : ["export"],
    })),
    proposal.members.map((member) => ({
      ...member,
      existingTicketId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    })),
    proposal.members.map((member) => ({
      ...member,
      existingTicketId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      expectedVersion: 1,
    })),
  ];
  for (const members of invalidMembers)
    expect(epicProposalInput.safeParse({ ...proposal, members }).success).toBe(false);
});
