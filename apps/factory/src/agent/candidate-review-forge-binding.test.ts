import { expect, test } from "bun:test";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import {
  forgeBinding,
  forgeBindingDatabase,
  forgeRepositoryBindingMatrix,
  useForgeBindingEnvironment,
} from "../../../../test/support/forge-repository-binding";
import { createCandidateReviewController } from "./candidate-review";

test("review binds injected Forge readers before source calls, retaining exact revisions, authority and limits", async () => {
  const restore = useForgeBindingEnvironment();
  const actor = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const turnID = crypto.randomUUID();
  const changeID = crypto.randomUUID();
  const reviewID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const commitSHA = "a".repeat(40);
  const baseSHA = "b".repeat(40);
  const ownerToken = "owned-review-lease";
  const { accepted, malformed } = forgeRepositoryBindingMatrix();
  let repositoryURL = "";
  let expectedRepository = { owner: forgeBinding.owner, name: "repo" };
  let lease = true;
  let fileSize = 100;
  let binary = false;
  const reads: Array<{ kind: string; ref: string }> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const turn = {
    id: turnID,
    command_id: crypto.randomUUID(),
    input: {
      kind: "change-review",
      commandId: crypto.randomUUID(),
      projectId: projectID,
      createdBy: actor,
      conversationId: null,
      ticketId: ticketID,
      changeId: changeID,
      reviewId: reviewID,
    },
    authority: {
      mode: "build",
      modelId: "owned-not-called",
      requirementRevisionId: crypto.randomUUID(),
      review: {
        reviewId: reviewID,
        verificationId: crypto.randomUUID(),
        commitSha: commitSHA,
        baseSha: baseSHA,
      },
    },
    state: "running",
    owner_token: ownerToken,
    owner_expires_at: new Date(Date.now() + 60_000),
    outcome_summary: null,
  };
  const fixture = forgeBindingDatabase(
    (text, parameters) => {
      if (text.startsWith("SELECT * FROM factory.agent_turn")) return lease ? [turn] : [];
      if (text.startsWith("SELECT id FROM factory.agent_turn"))
        return lease ? [{ id: turnID }] : [];
      if (text.startsWith("SELECT change.project_id")) return [{ projectID, available: true }];
      if (text.startsWith("SELECT state") && text.includes("FROM factory.change_writer"))
        return [{ state: "agent", turnID, epoch: "1" }];
      if (text.startsWith("SELECT change.id")) return [{ id: changeID }];
      if (text.startsWith("SELECT review.id,review.change_id"))
        return [
          {
            id: reviewID,
            changeID,
            commitSHA,
            baseSHA,
            repositoryURL,
            evidence,
            result: null,
            findingSourceID: null,
            previousSHA: null,
            focusNeedsApp: false,
            criteria: 1,
            coverageVersion: 1,
            attemptID: crypto.randomUUID(),
          },
        ];
      if (text.startsWith("SELECT review.id")) return [{ id: reviewID }];
      if (
        text.includes("FROM factory.change_agent_session") ||
        text.includes("FROM factory.ticket_conversation") ||
        text.includes("FROM factory.review_scenario")
      )
        return [];
      if (text.startsWith("UPDATE factory.candidate_review SET evidence")) {
        evidence.push(...JSON.parse(String(parameters[0])));
        return [];
      }
      throw new Error(`Unexpected review query: ${text}`);
    },
    (text) => {
      if (text.includes('"auth"."user"')) return [[actor]];
      if (text.includes('"factory"."account_access"')) return [[null, null]];
      if (text.includes('"factory"."project_membership"')) return [["developer", false]];
      if (text.includes('"factory"."administrator"')) return [];
      if (text.includes('"factory"."project"')) return [[projectID]];
      throw new Error(`Unexpected review authority query: ${text}`);
    },
  );
  const reader = {
    async listFiles(repository: unknown, ref: string) {
      expect(repository).toEqual(expectedRepository);
      expect([commitSHA, baseSHA]).toContain(ref);
      reads.push({ kind: "tree", ref });
      return [{ path: "src/sum.ts", sha: ref, size: fileSize }];
    },
    async getFile(repository: unknown, path: string, ref: string) {
      expect(repository).toEqual(expectedRepository);
      expect(path).toBe("src/sum.ts");
      expect([commitSHA, baseSHA]).toContain(ref);
      reads.push({ kind: "file", ref });
      return binary ? "source\0" : `export const sum = ${ref === commitSHA ? "1 + 1" : "1 - 1"};\n`;
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  const controller = createCandidateReviewController(fixture.database, reader);
  const calls = [
    { name: "review_files", arguments: {} },
    { name: "review_read", arguments: { path: "src/sum.ts" } },
    { name: "review_diff", arguments: { path: "src/sum.ts" } },
    { name: "review_search", arguments: { query: "sum" } },
  ];
  try {
    for (const value of accepted) {
      repositoryURL = value.url;
      expectedRepository = value.repository;
      for (const raw of calls) await controller.call(turnID, ownerToken, raw, crypto.randomUUID());
    }
    expect(evidence.length).toBe(accepted.length * calls.length);
    const before = { reads: reads.length, evidence: evidence.length };
    for (repositoryURL of malformed) {
      for (const raw of calls)
        await expect(controller.call(turnID, ownerToken, raw, crypto.randomUUID())).rejects.toThrow(
          "Review repository is not the configured Project forge",
        );
      expect(reads).toHaveLength(before.reads);
      expect(evidence).toHaveLength(before.evidence);
    }
    repositoryURL = accepted[0]?.url ?? "";
    lease = false;
    await expect(controller.call(turnID, ownerToken, calls[0], "revoked")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(reads).toHaveLength(before.reads);
    lease = true;
    repositoryURL = `${forgeBinding.publicURL}/owned/bounded.git`;
    expectedRepository = { owner: "owned", name: "bounded" };
    fileSize = 1_048_577;
    await expect(controller.call(turnID, ownerToken, calls[1], "oversized")).rejects.toThrow(
      "1 MiB",
    );
    expect(reads.slice(before.reads).every(({ kind }) => kind === "tree")).toBe(true);
    repositoryURL = `${forgeBinding.publicURL}/owned/binary.git`;
    expectedRepository = { owner: "owned", name: "binary" };
    fileSize = 8;
    binary = true;
    await expect(controller.call(turnID, ownerToken, calls[1], "binary")).rejects.toThrow(
      "bounded text file",
    );
    expect(evidence).toHaveLength(before.evidence);
  } finally {
    restore();
  }
});
