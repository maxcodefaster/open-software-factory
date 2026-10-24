import { expect, test } from "bun:test";
import { createCandidateReviewController } from "../../apps/factory/src/agent/candidate-review";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { candidateReviewPermissions } from "../../packages/conversation-domain/src/candidate-review";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe } from "../fixtures/pinned-opencode";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";

function sourceFixture(ui = false) {
  const path = ui ? "src/app.tsx" : "src/sum.ts";
  const before = "export const sum = (a, b) => a - b;\n";
  const after = "export const sum = (a, b) => a + b;\n";
  const refs: string[] = [];
  const forge = {
    listFiles: async (_repository: unknown, ref: string) => {
      refs.push(ref);
      return [{ path, sha: ref.charAt(0).repeat(40), size: 100 }];
    },
    getFile: async (_repository: unknown, file: string, ref: string) => {
      expect(file).toBe(path);
      refs.push(ref);
      return ref === "a".repeat(40) ? before : after;
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  return { path, refs, forge };
}
const passed = {
  verdict: "passed" as const,
  summary: "Correct addition.",
  criteria: [
    {
      criterion: 1,
      status: "passed" as const,
      evidence: "The immutable candidate adds both operands.",
    },
  ],
  findings: [],
  ui: "not-applicable" as const,
};
async function observedCases(
  controller: ReturnType<typeof createCandidateReviewController>,
  turn: { id: string; ownerToken: string },
  path: string,
  context?: Parameters<typeof controller.observeBrowser>[4]["structuredContent"],
) {
  for (const [index, category] of (["normal", "boundary"] as const).entries()) {
    const id = `case-${index}`;
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_scenario",
        arguments: {
          id,
          title: category === "normal" ? "Ordinary sum" : "Zero boundary",
          category,
          observationKind: context ? "app" : "source",
          criterion: 1,
          expected: "Adds operands correctly",
        },
      },
      `start-${id}`,
    );
    await controller.call(
      turn.id,
      turn.ownerToken,
      { name: "review_read", arguments: { path } },
      `source-${id}`,
    );
    if (context)
      await controller.observeBrowser(
        turn.id,
        turn.ownerToken,
        { name: "browser_snapshot", arguments: {} },
        `browser-${id}`,
        { structuredContent: context, content: [{ type: "text", text: "Observed the App." }] },
      );
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_scenario_result",
        arguments: {
          id,
          status: "passed",
          observed: "Expected sum follows from the observed candidate",
        },
      },
      `end-${id}`,
    );
  }
}

test("independent review freezes the exact candidate and the original Coding configuration", async () => {
  const f = await candidateReviewFixture();
  try {
    const admission = createReviewAdmission(f.database);
    const a = await admission(f.changeID, f.reviewID, f.userID);
    const b = await admission(f.changeID, f.reviewID, f.userID);
    expect(a.turn.id).toBe(b.turn.id);
    expect(a.turn.authority).toMatchObject({
      mode: "build",
      modelId: buildModelID,
      codingReasoning: "medium",
      review: {
        commitSha: f.commit,
        baseSha: "a".repeat(40),
        verificationId: f.verificationID,
        reviewId: f.reviewID,
      },
    });
    const [intent] = await f.database.client<{ session: string; text: string }[]>`
      SELECT session_id AS session,prompt_text AS text FROM factory.change_agent_turn_intent WHERE turn_id=${a.turn.id}`;
    expect(intent?.session).not.toBe(f.sessionID);
    expect(intent?.text).toContain("independent candidate reviewer");
    expect(intent?.text).toContain(`Successful protected Forgejo Verification ${f.verificationID}`);
    await expect(
      (async () => {
        await f.database
          .client`UPDATE factory.candidate_review SET commit_sha=${"e".repeat(40)} WHERE id=${f.reviewID}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      createChangeAdmission(f.database, buildModelID).admit(f.changeID, f.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Do not race the reviewer.",
      }),
    ).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test("review source comes only from immutable Git refs and a report needs observed evidence", async () => {
  const f = await candidateReviewFixture();
  const source = sourceFixture();
  const controller = createCandidateReviewController(f.database, source.forge);
  try {
    const turn = await f.activeReview();
    const call = (name: string, args: unknown, id: string | number) =>
      controller.call(turn.id, turn.ownerToken, { name, arguments: args }, id);
    await expect(call("review_report", passed, 1)).rejects.toThrow("source evidence");
    const diff = await call("review_diff", { path: source.path }, 2);
    expect(JSON.stringify(diff)).toContain("+export const sum = (a, b) => a + b");
    expect(source.refs.every((ref) => [f.commit, "a".repeat(40)].includes(ref))).toBe(true);
    await expect(call("review_report", passed, "no-cases")).rejects.toThrow("normal coverage");
    await observedCases(controller, turn, source.path);
    await expect(
      call("review_report", { ...passed, criteria: [{ ...passed.criteria[0], criterion: 2 }] }, 3),
    ).rejects.toThrow("every approved");
    await call("review_report", passed, 4);
    expect((await f.review())?.state).toBe("running");
    await call("review_report", passed, 4);
    await expect(
      call("review_report", { ...passed, summary: "Changed report" }, 5),
    ).rejects.toThrow("immutable");
    await expect(call("review_diff", { path: source.path }, 6)).rejects.toThrow("already recorded");
    await f.controller().stop(f.changeID);
    await expect(call("review_report", passed, 7)).rejects.toThrow();
    expect((await f.review())?.state).not.toBe("passed");
  } finally {
    await f.dispose();
  }
});

test("frontend review rejects missing, dirty and different-commit screenshots", async () => {
  const f = await candidateReviewFixture();
  const source = sourceFixture(true);
  const controller = createCandidateReviewController(f.database, source.forge);
  try {
    const turn = await f.activeReview();
    await controller.call(
      turn.id,
      turn.ownerToken,
      { name: "review_diff", arguments: { path: source.path } },
      1,
    );
    const report = { name: "review_report", arguments: passed };
    await expect(controller.call(turn.id, turn.ownerToken, report, 2)).rejects.toThrow(
      "actual App review",
    );
    const checked = { ...report, arguments: { ...passed, ui: "checked" } };
    await expect(controller.call(turn.id, turn.ownerToken, checked, 3)).rejects.toThrow(
      "screenshot",
    );
    const context = {
      sessionId: crypto.randomUUID(),
      turnId: turn.id,
      changeId: f.changeID,
      runtimeAttemptId: f.attemptID,
      generation: 1,
      app: "app",
      headCommit: f.commit,
      workingTreeModified: false,
      observedAt: new Date().toISOString(),
    };
    for (const changed of [{ headCommit: "b".repeat(40) }, { workingTreeModified: true }])
      await expect(
        controller.observeBrowser(
          turn.id,
          turn.ownerToken,
          { name: "browser_screenshot", arguments: {} },
          4,
          {
            structuredContent: { ...context, ...changed },
            content: [{ type: "image", mimeType: "image/jpeg", data: "aGVsbG8=" }],
          },
        ),
      ).rejects.toThrow("clean reviewed commit");
    await controller.observeBrowser(
      turn.id,
      turn.ownerToken,
      { name: "browser_screenshot", arguments: {} },
      5,
      {
        structuredContent: context,
        content: [{ type: "image", mimeType: "image/jpeg", data: "aGVsbG8=" }],
      },
    );
    await observedCases(controller, turn, source.path, context);
    await controller.call(turn.id, turn.ownerToken, checked, 6);
    expect((await f.review())?.result).toMatchObject({ verdict: "passed", ui: "checked" });
    expect(JSON.stringify((await f.review())?.evidence)).toContain("screenshotSHA256");
    expect(JSON.stringify((await f.review())?.evidence)).not.toContain("aGVsbG8=");
  } finally {
    await f.dispose();
  }
});

test("a frontend review can cover protected checks with an observed source-only case", async () => {
  const f = await candidateReviewFixture(
    canonicalRequirementContent({
      summary: "Review the App and its protected checks",
      acceptanceCriteria: ["The App behaves correctly", "The protected repository checks pass"],
      nonGoals: [],
    }),
  );
  const source = sourceFixture(true);
  const controller = createCandidateReviewController(f.database, source.forge);
  try {
    const turn = await f.activeReview();
    const context = {
      sessionId: crypto.randomUUID(),
      turnId: turn.id,
      changeId: f.changeID,
      runtimeAttemptId: f.attemptID,
      generation: 1,
      app: "app",
      headCommit: f.commit,
      workingTreeModified: false,
      observedAt: new Date().toISOString(),
    };
    await controller.observeBrowser(
      turn.id,
      turn.ownerToken,
      { name: "browser_screenshot", arguments: {} },
      "candidate-screenshot",
      {
        structuredContent: context,
        content: [{ type: "image", mimeType: "image/jpeg", data: "aGVsbG8=" }],
      },
    );
    await observedCases(controller, turn, source.path, context);
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_scenario",
        arguments: {
          id: "protected-checks",
          title: "Protected source checks",
          category: "normal",
          observationKind: "source",
          criterion: 2,
          expected: "The exact verified candidate has relevant protected checks",
        },
      },
      "checks-start",
    );
    await expect(
      (async () => {
        await f.database.client`
        UPDATE factory.review_scenario SET observation_kind='app'
        WHERE review_id=${f.reviewID} AND id='protected-checks'`;
      })(),
    ).rejects.toThrow("immutable");
    await controller.call(
      turn.id,
      turn.ownerToken,
      { name: "review_read", arguments: { path: source.path } },
      "checks-read",
    );
    await controller.observeBrowser(
      turn.id,
      turn.ownerToken,
      { name: "browser_snapshot", arguments: {} },
      "incidental-source-case-app-view",
      {
        structuredContent: { ...context, recordingTimeMs: 5000 },
        content: [{ type: "text", text: "The App remained visible during source inspection" }],
      },
    );
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_scenario_result",
        arguments: {
          id: "protected-checks",
          status: "passed",
          observed:
            "Inspected the immutable source; Factory already confirmed this exact candidate's CI",
        },
      },
      "checks-result",
    );
    const [sourceCase] = await f.database.client<
      { kind: string; position: string | null; session: string | null }[]
    >`SELECT observation_kind AS kind,media_started_ms::text AS position,media_session_id AS session
      FROM factory.review_scenario WHERE review_id=${f.reviewID} AND id='protected-checks'`;
    expect(sourceCase).toEqual({ kind: "source", position: null, session: null });
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_report",
        arguments: {
          ...passed,
          ui: "checked",
          criteria: [
            passed.criteria[0],
            {
              criterion: 2,
              status: "passed",
              evidence: "Exact successful CI and inspected source",
            },
          ],
        },
      },
      "mixed-report",
    );
    expect((await f.review())?.result).toMatchObject({ verdict: "passed" });
  } finally {
    await f.dispose();
  }
});

test("an App case cannot be closed as passing before its own App observation", async () => {
  const f = await candidateReviewFixture();
  const source = sourceFixture(true);
  const controller = createCandidateReviewController(f.database, source.forge);
  try {
    const turn = await f.activeReview();
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_scenario",
        arguments: {
          id: "app-case",
          title: "Actual App behavior",
          category: "normal",
          criterion: 1,
          expected: "The visible App behaves correctly",
        },
      },
      "app-start",
    );
    await controller.call(
      turn.id,
      turn.ownerToken,
      { name: "review_read", arguments: { path: source.path } },
      "source-only",
    );
    await expect(
      controller.call(
        turn.id,
        turn.ownerToken,
        {
          name: "review_scenario_result",
          arguments: { id: "app-case", status: "passed", observed: "Only source was inspected" },
        },
        "premature-result",
      ),
    ).rejects.toThrow("actual App observation");
    const [row] = await f.database.client<{ active: boolean; status: string | null }[]>`
      SELECT ended_at IS NULL AS active,status FROM factory.review_scenario
      WHERE review_id=${f.reviewID} AND id='app-case'`;
    expect(row).toEqual({ active: true, status: null });
    await controller.observeBrowser(
      turn.id,
      turn.ownerToken,
      { name: "browser_snapshot", arguments: {} },
      "actual-app-observation",
      {
        structuredContent: {
          sessionId: crypto.randomUUID(),
          turnId: turn.id,
          changeId: f.changeID,
          runtimeAttemptId: f.attemptID,
          generation: 1,
          app: "app",
          headCommit: f.commit,
          workingTreeModified: false,
          observedAt: new Date().toISOString(),
        },
        content: [{ type: "text", text: "The active case inspected the actual App" }],
      },
    );
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_scenario_result",
        arguments: {
          id: "app-case",
          status: "passed",
          observed: "The App matched its expected state",
        },
      },
      "observed-result",
    );
    const [completed] = await f.database.client<{ active: boolean; status: string }[]>`
      SELECT ended_at IS NULL AS active,status FROM factory.review_scenario
      WHERE review_id=${f.reviewID} AND id='app-case'`;
    expect(completed).toEqual({ active: false, status: "passed" });
  } finally {
    await f.dispose();
  }
});

test("source checks cannot replace normal and adverse App coverage for user-facing changes", async () => {
  const f = await candidateReviewFixture();
  const source = sourceFixture(true);
  const controller = createCandidateReviewController(f.database, source.forge);
  try {
    const turn = await f.activeReview();
    await controller.observeBrowser(
      turn.id,
      turn.ownerToken,
      { name: "browser_screenshot", arguments: {} },
      "global-screenshot",
      {
        structuredContent: {
          sessionId: crypto.randomUUID(),
          turnId: turn.id,
          changeId: f.changeID,
          runtimeAttemptId: f.attemptID,
          generation: 1,
          app: "app",
          headCommit: f.commit,
          workingTreeModified: false,
          observedAt: new Date().toISOString(),
        },
        content: [{ type: "image", mimeType: "image/jpeg", data: "aGVsbG8=" }],
      },
    );
    await observedCases(controller, turn, source.path);
    await expect(
      controller.call(
        turn.id,
        turn.ownerToken,
        { name: "review_report", arguments: { ...passed, ui: "checked" } },
        "source-cannot-certify-ui",
      ),
    ).rejects.toThrow("source checks cannot replace");
    expect((await f.review())?.result).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("a source case needs its own candidate read or diff, not merely a base read", async () => {
  const f = await candidateReviewFixture();
  const source = sourceFixture();
  const controller = createCandidateReviewController(f.database, source.forge);
  try {
    const turn = await f.activeReview();
    await controller.call(
      turn.id,
      turn.ownerToken,
      {
        name: "review_scenario",
        arguments: {
          id: "source-case",
          title: "Current source check",
          category: "normal",
          observationKind: "source",
          criterion: 1,
          expected: "The candidate uses correct addition",
        },
      },
      "source-start",
    );
    await controller.call(
      turn.id,
      turn.ownerToken,
      { name: "review_read", arguments: { path: source.path, revision: "base" } },
      "base-read",
    );
    const result = {
      name: "review_scenario_result",
      arguments: { id: "source-case", status: "passed", observed: "Inspected addition" },
    };
    await expect(controller.call(turn.id, turn.ownerToken, result, "too-early")).rejects.toThrow(
      "immutable candidate source",
    );
    await controller.call(
      turn.id,
      turn.ownerToken,
      { name: "review_diff", arguments: { path: source.path } },
      "candidate-diff",
    );
    await controller.call(turn.id, turn.ownerToken, result, "source-observed");
  } finally {
    await f.dispose();
  }
});

test("large immutable inventories keep valid bounded pages and an advancing cursor", async () => {
  const f = await candidateReviewFixture();
  const files = Array.from({ length: 50 }, (_, index) => ({
    path: `src/${index}-${"component".repeat(70)}.tsx`,
    sha: "b".repeat(40),
    size: 100,
  }));
  const controller = createCandidateReviewController(f.database, {
    listFiles: async (_repository: unknown, ref: string) => (ref === f.commit ? files : []),
  } as unknown as ReturnType<typeof createForgejoClient>);
  try {
    const turn = await f.activeReview();
    const result = await controller.call(
      turn.id,
      turn.ownerToken,
      { name: "review_files", arguments: {} },
      1,
    );
    const part = result.content[0];
    if (part?.type !== "text") throw new Error("Missing bounded source page");
    expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(32_000);
    const page = JSON.parse(part.text);
    expect(page.files.length).toBeGreaterThan(0);
    expect(page.files.length).toBeLessThan(50);
    expect(page.nextOffset).toBe(page.files.length);
  } finally {
    await f.dispose();
  }
});

test.each([false, true])(
  "native finish with accepted report=%s never commits review code and retains implementation identity",
  async (hasReport) => {
    const f = await candidateReviewFixture();
    const request = f.hub.request.bind(f.hub);
    let native: { id: string; permissions: unknown } | undefined;
    f.hub.request = async (attempt, channel, input, path) => {
      const pathname = new URL(input.url).pathname;
      if (pathname === "/api/session" && input.method === "POST") {
        native = await input.json();
        return Response.json({ data: native });
      }
      if (native && pathname === `/api/session/${native.id}`)
        return Response.json({
          data: {
            ...native,
            location: { directory: "/workspace/project" },
            model: { providerID: "factory", id: buildModelID },
          },
        });
      if (native && pathname.endsWith("/log"))
        return new Response(
          `data: ${JSON.stringify({ type: "log.synced", aggregateID: native.id, seq: 1 })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      return request(attempt, channel, input, path);
    };
    try {
      const controller = f.controller();
      await controller.review(f.changeID, f.reviewID, f.userID);
      await f.requested;
      expect(native?.permissions).toEqual(candidateReviewPermissions);
      expect(native?.id).not.toBe(f.sessionID);
      f.release();
      f.acceptResponse();
      await observe(
        () => f.review(),
        (review) => review?.state === "running",
      );
      if (hasReport) {
        const source = sourceFixture();
        const review = createCandidateReviewController(f.database, source.forge);
        const [turn] = await f.database.client<
          { id: string; token: string }[]
        >`SELECT id,owner_token AS token FROM factory.agent_turn WHERE command_id=${f.reviewID}`;
        if (!turn) throw new Error("Missing running review");
        await review.call(
          turn.id,
          turn.token,
          { name: "review_read", arguments: { path: source.path } },
          1,
        );
        await observedCases(review, { id: turn.id, ownerToken: turn.token }, source.path);
        await review.call(turn.id, turn.token, { name: "review_report", arguments: passed }, 2);
      }
      f.finish("Independent review finished.");
      await observe(
        () => f.review(),
        (review) => review?.state === (hasReport ? "passed" : "incomplete"),
      );
      const [session] = await f.database.client<
        { state: string; current: string; implementation: string }[]
      >`
      SELECT state,opencode_session_id AS current,implementation_session_id AS implementation
      FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      expect(session).toMatchObject({
        state: "committed",
        current: native?.id,
        implementation: f.sessionID,
      });
      expect(f.commitCalls).toEqual([]);
      const correction = await createChangeAdmission(f.database, buildModelID).admit(
        f.changeID,
        f.userID,
        {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Correct the retained implementation.",
        },
      );
      const [intent] = await f.database.client<
        { session: string }[]
      >`SELECT session_id AS session FROM factory.change_agent_turn_intent WHERE turn_id=${correction.turn.id}`;
      expect(intent?.session).toBe(f.sessionID);
    } finally {
      await f.dispose();
    }
  },
);
