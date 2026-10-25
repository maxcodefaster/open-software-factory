import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import {
  type CandidateReviewResult,
  candidateReviewResultInput,
} from "../../packages/conversation-domain/src/candidate-review";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe } from "../fixtures/pinned-opencode";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import { createMonitoringController } from "../../apps/factory/src/monitoring/controller";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createDeliveryService } from "../../apps/factory/src/delivery/service";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";
import { decodeResponse } from "@solidjs/web/server-functions/client";

async function setup(autofix = false) {
  const f = await candidateReviewFixture(undefined, undefined, autofix);
  await f.database.client`INSERT INTO factory.pull_request_operation(
    id,change_id,repository_owner,repository_name,base_branch,head_branch,first_head_sha,
    title,body,idempotency_key,state,pull_request_number,pull_request_url,completed_at)
    SELECT ${crypto.randomUUID()},id,'owned','review','main',branch_name,${f.commit},
      'Owned review','','owned-'||id,'succeeded',1,'https://forge.invalid/owned/review/pulls/1',now()
    FROM factory.change WHERE id=${f.changeID}`;
  let head = f.commit;
  let base = "a".repeat(40);
  let merges = 0;
  let changedFiles = ["src/invoice.ts", "test/invoice.test.ts"];
  let baseReads = 0;
  let beforeMergeRead: (() => Promise<void>) | undefined;
  const reviews: string[] = [];
  const corrections: string[] = [];
  const forge = {
    getPullRequest: async () => ({ number: 1, headSha: head, merged: false }),
    getDefaultBranch: async () => {
      baseReads++;
      if (baseReads > 1) await beforeMergeRead?.();
      return { headSha: base };
    },
    listFiles: async (_repository: unknown, ref: string) =>
      changedFiles.map((path) => ({
        path,
        sha: ref === "a".repeat(40) ? "b".repeat(40) : "c".repeat(40),
        size: 10,
      })),
    listActionRuns: async () => [],
    mergeFastForward: async () => {
      merges++;
      base = head;
      return { headSha: head };
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  const controller = createDeliveryController(
    f.database,
    {
      startVerification: async () => {
        throw new Error("Exact completed CI needs no new compute");
      },
      startStagingReplacement: async () => null,
      stop: async () => null,
    },
    {
      review: async (changeID, reviewID, userID) => {
        const accepted = await createReviewAdmission(f.database)(changeID, reviewID, userID);
        if (!accepted.replayed) reviews.push(accepted.turn.id);
      },
      prompt: async (changeID, text, userID, commandID) => {
        const accepted = await createChangeAdmission(f.database, buildModelID).admit(
          changeID,
          userID,
          {
            kind: "change-repair",
            commandId: commandID,
            text,
          },
        );
        if (!accepted.replayed) corrections.push(text);
      },
    },
    async () => {},
    { client: forge, owner: "owned" },
  );
  async function complete(result: CandidateReviewResult | null) {
    const turn = await f.activeReview();
    await f.turns.settle(
      turn.id,
      turn.ownerToken,
      "completed",
      result?.summary ?? "Incomplete",
      async (sql) => {
        await sql`UPDATE factory.candidate_review SET state=${result?.verdict ?? "incomplete"},
        result=${result === null ? null : JSON.stringify(result)}::jsonb,completed_at=now() WHERE id=${f.reviewID}`;
        await sql`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
      },
    );
  }
  const origin = "https://owned-candidate-delivery.test";
  const endpoint = await compiledFactoryEndpoint({
    origin,
    session: async (request) => ({
      user: { id: request.headers.get("x-owned-actor") ?? f.userID },
    }),
    maintenance: async () => false,
    requireFresh: async () => {},
    services: {
      delivery: createDeliveryService({ access: createAccessController(f.database), controller }),
    } as unknown as FactoryServices,
  });
  async function native(name: string, args: unknown[], userID = f.userID) {
    const result = await decodeResponse<ServerResult<unknown>>(
      await endpoint(await factoryFunctionRequest(origin, name, args, { "x-owned-actor": userID })),
    );
    if (!result) throw new Error("Owned Delivery command returned no result");
    return serverCall(Promise.resolve(result));
  }
  return {
    ...f,
    controller,
    native,
    reviews,
    corrections,
    complete,
    merges: () => merges,
    base: () => base,
    setFiles: (files: string[]) => {
      changedFiles = files;
    },
    beforeMergeRead: (callback: () => Promise<void>) => {
      beforeMergeRead = callback;
    },
    setHead: (value: string) => {
      head = value;
    },
  };
}
const passed = candidateReviewResultInput.parse({
  verdict: "passed",
  summary: "Approved behavior independently inspected.",
  criteria: [
    {
      criterion: 1,
      status: "passed",
      evidence: "Observed the required behavior in the exact candidate.",
    },
  ],
  findings: [],
  ui: "not-applicable",
});

test("Autofix records delegated Delivery provenance and merges only the exact independently reviewed application candidate", async () => {
  const f = await setup(true);
  try {
    if (!f.monitoring) throw new Error("Missing owned monitoring delegation");
    await expect(
      f.controller.approve(f.changeID, f.userID, f.monitoring.incidentID),
    ).rejects.toThrow("eligible");
    await f.complete(passed);
    const review = await f.turns.getByCommand(f.reviewID);
    expect(review?.authority).toMatchObject({
      mode: "build",
      monitoringIncidentId: f.monitoring.incidentID,
    });
    expect(
      await f.database
        .client`SELECT turn_id FROM factory.agent_turn_mcp WHERE turn_id=${review?.id ?? null}`,
    ).toHaveLength(0);
    await f.controller.approve(f.changeID, f.userID, f.monitoring.incidentID);
    await observe(
      () => f.controller.get(f.changeID),
      (value) => value?.["mergeState"] === "succeeded",
    );
    expect(f.merges()).toBe(1);
    expect(f.base()).toBe(f.commit);
    const [approval] = await f.database.client<
      { incident: string; policy: string; commit: string; review: string }[]
    >`
      SELECT monitoring_incident_id AS incident,monitoring_policy_id AS policy,commit_sha AS commit,candidate_review_id AS review
      FROM factory.delivery_approval WHERE change_id=${f.changeID}`;
    expect(approval).toEqual({
      incident: f.monitoring.incidentID,
      policy: f.monitoring.policyID,
      commit: f.commit,
      review: f.reviewID,
    });
    expect(
      await f.database.client`SELECT id FROM factory.monitoring_evidence
      WHERE incident_id=${f.monitoring.incidentID} AND kind='delivery-candidate' AND commit_sha=${f.commit}`,
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test.each(["package.json", ".forgejo/workflows/check.yml", "infra/runtime.ts"])(
  "Autofix cannot approve operational or dependency changes in %s",
  async (path) => {
    const f = await setup(true);
    try {
      if (!f.monitoring) throw new Error("Missing owned monitoring delegation");
      await f.complete(passed);
      f.setFiles([path]);
      await expect(
        f.controller.approve(f.changeID, f.userID, f.monitoring.incidentID),
      ).rejects.toThrow("application-code");
      expect(f.merges()).toBe(0);
      expect(
        await f.database
          .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
      ).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  },
);

test("Autofix cannot approve an open human Thread or stale candidate", async () => {
  const f = await setup(true);
  try {
    if (!f.monitoring) throw new Error("Missing owned monitoring delegation");
    await f.complete(passed);
    const human = createVisualReviewController(f.database);
    const feedback = await human.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "The observed edge case still needs checking.",
    });
    await expect(
      f.controller.approve(f.changeID, f.userID, f.monitoring.incidentID),
    ).rejects.toThrow("open review Threads");
    await human.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: feedback.feedbackId,
      expectedVersion: 1,
      action: "resolve",
    });
    f.setHead("e".repeat(40));
    await expect(
      f.controller.approve(f.changeID, f.userID, f.monitoring.incidentID),
    ).rejects.toThrow("eligible");
    expect(f.merges()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("disabling Autofix after approval but before merge fences the irreversible command", async () => {
  const f = await setup(true);
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    if (!f.monitoring) throw new Error("Missing owned monitoring delegation");
    await f.complete(passed);
    f.beforeMergeRead(async () => {
      reached.resolve();
      await release.promise;
    });
    await f.controller.approve(f.changeID, f.userID, f.monitoring.incidentID);
    await reached.promise;
    await createMonitoringController(
      f.database,
      "owned-key",
      "https://factory.example",
      () => {},
    ).change(f.projectID, f.monitoring.hookID, f.userID, "disable", {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    release.resolve();
    await observe(
      () => f.controller.get(f.changeID),
      (value) => value?.["mergeState"] === "failed",
    );
    expect(f.merges()).toBe(0);
    expect(f.base()).toBe("a".repeat(40));
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("human source takeover disables delegated Delivery without removing explicit human approval", async () => {
  const f = await setup(true);
  try {
    if (!f.monitoring) throw new Error("Missing owned monitoring delegation");
    await f.complete(passed);
    const writer = await f.writers.takeOver(f.changeID, f.userID, crypto.randomUUID());
    expect(writer.canWrite).toBe(true);
    const details = await f.controller.get(f.changeID);
    expect(details?.["monitoringState"]).toBe("blocked");
    expect(details?.["monitoringReason"]).toContain("source editing");
    await expect(
      f.controller.approve(f.changeID, f.userID, f.monitoring.incidentID),
    ).rejects.toThrow();
    expect(f.merges()).toBe(0);
    await f.controller.approve(f.changeID, f.userID);
    await observe(
      () => f.controller.get(f.changeID),
      (value) => value?.["mergeState"] === "succeeded",
    );
    const [approval] = await f.database.client<{ policy: string | null }[]>`
      SELECT monitoring_policy_id AS policy FROM factory.delivery_approval WHERE change_id=${f.changeID}`;
    expect(approval?.policy).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("ordinary comments do not block Delivery, but open and implemented Threads do", async () => {
  const f = await setup();
  try {
    await f.complete(passed);
    const human = createVisualReviewController(f.database);
    await human.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "comment",
      body: "Looks good.",
    });
    const thread = await human.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Please check the empty state.",
    });
    expect((await f.controller.get(f.changeID))?.["openReviewThreads"]).toBe(1);
    await expect(f.controller.approve(f.changeID, f.userID)).rejects.toThrow("open review Threads");
    await f.database
      .client`UPDATE factory.review_feedback SET state='implemented' WHERE id=${thread.feedbackId!}`;
    await expect(f.controller.approve(f.changeID, f.userID)).rejects.toThrow("open review Threads");
    await human.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: thread.feedbackId,
      expectedVersion: 1,
      action: "resolve",
    });
    await f.controller.approve(f.changeID, f.userID);
    expect((await f.controller.get(f.changeID))?.["approvedAt"]).toBeDefined();
    await expect(
      human.create(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        kind: "thread",
        body: "Too late to race the merge",
      }),
    ).rejects.toThrow("read-only");
  } finally {
    await f.dispose();
  }
});

test("Delivery rechecks Threads after waiting on the shared Change lock", async () => {
  const f = await setup();
  const locked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let writer: Promise<unknown> | undefined;
  try {
    await f.complete(passed);
    writer = f.database.client.begin(async (sql) => {
      await sql`SELECT id FROM factory.change WHERE id=${f.changeID} FOR UPDATE`;
      await sql`INSERT INTO factory.review_feedback(id,change_id,author_id,kind,commit_sha)
        VALUES(${crypto.randomUUID()},${f.changeID},${f.userID},'thread',${f.commit})`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const approving = f.controller.approve(f.changeID, f.userID).then(
      () => null,
      (cause: unknown) => cause,
    );
    await observe(
      async () => {
        const [row] = await f.database.client<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND position('FOR UPDATE OF change,ticket' IN query)>0) AS waiting`;
        return row?.waiting;
      },
      Boolean,
      "Delivery did not contend for the Change lock",
    );
    release.resolve();
    await writer;
    const failure = await approving;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("open review Threads");
    const approvals = await f.database
      .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`;
    expect(approvals).toHaveLength(0);
  } finally {
    release.resolve();
    await writer?.catch(() => {});
    await f.dispose();
  }
});

test("a settled Stop can resume submitted checks without repeating implementation or clearing a later Stop", async () => {
  const f = await setup();
  try {
    const stopID = crypto.randomUUID();
    await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
      stop_id=${stopID},stop_pending=false WHERE change_id=${f.changeID}`;
    await f.controller.reconcile(f.changeID);
    expect(f.reviews).toHaveLength(0);
    expect(await f.native("getDelivery", [f.changeID])).toMatchObject({ checksStopId: stopID });
    const commandID = crypto.randomUUID();
    await Promise.all([
      f.native("resumeVerification", [
        f.changeID,
        { commandId: commandID, verificationId: f.verificationID, stopId: stopID },
      ]),
      f.native("resumeVerification", [
        f.changeID,
        { commandId: commandID, verificationId: f.verificationID, stopId: stopID },
      ]),
    ]);
    await f.controller.reconcile(f.changeID);
    expect(f.reviews).toHaveLength(1);
    expect(f.requests()).toBe(0);
    expect(f.corrections).toHaveLength(0);
    const [implementation] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.agent_turn WHERE id=${f.initial.id}`;
    expect(implementation?.state).toBe("completed");
    const laterStopID = crypto.randomUUID();
    await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
      stop_id=${laterStopID},stop_pending=false WHERE change_id=${f.changeID}`;
    await f.native("resumeVerification", [
      f.changeID,
      { commandId: commandID, verificationId: f.verificationID, stopId: stopID },
    ]);
    const [session] = await f.database.client<{ state: string; stopID: string }[]>`
      SELECT state,stop_id AS "stopID" FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
    expect(session).toMatchObject({ state: "stopped", stopID: laterStopID });
    await expect(
      f.native("resumeVerification", [
        f.changeID,
        { commandId: commandID, verificationId: f.verificationID, stopId: laterStopID },
      ]),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.dispose();
  }
});

test.each([
  "unconfirmed-stop",
  "newer-stop",
  "human-writer",
  "unfinished-source",
  "contributor",
  "wrong-verification",
  "cancelling",
])(
  "resuming checks refuses %s instead of bypassing its authority or source fence",
  async (condition) => {
    const f = await setup();
    try {
      const stopID = crypto.randomUUID();
      await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
        stop_id=${stopID},stop_pending=${condition === "unconfirmed-stop"} WHERE change_id=${f.changeID}`;
      if (condition === "human-writer")
        await f.database.client`UPDATE factory.change_writer SET state='human',turn_id=NULL,
          user_id=${f.userID},fence_required=false,fence_attempt_id=NULL WHERE change_id=${f.changeID}`;
      if (condition === "unfinished-source")
        await f.database
          .client`UPDATE factory.change_agent_session SET active_turn_id=NULL WHERE change_id=${f.changeID}`;
      if (condition === "contributor")
        await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
          WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      if (condition === "cancelling")
        await f.database.client`UPDATE factory.change SET cancel_requested_at=now()
          WHERE id=${f.changeID}`;
      if (!["contributor", "newer-stop", "wrong-verification"].includes(condition))
        expect((await f.controller.get(f.changeID))?.["checksStopId"]).toBeNull();
      await expect(
        f.controller.resumeChecks(
          f.changeID,
          f.userID,
          crypto.randomUUID(),
          condition === "wrong-verification" ? crypto.randomUUID() : f.verificationID,
          condition === "newer-stop" ? crypto.randomUUID() : stopID,
        ),
      ).rejects.toMatchObject({ code: condition === "contributor" ? "forbidden" : "conflict" });
      const [session] = await f.database.client<{ state: string }[]>`
        SELECT state FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      expect(session?.state).toBe("stopped");
      expect(f.reviews).toHaveLength(0);
      expect(f.requests()).toBe(0);
    } finally {
      await f.dispose();
    }
  },
);

test("successful CI alone cannot deliver and admits just one independent review", async () => {
  const f = await setup();
  try {
    await expect(f.controller.approve(f.changeID, f.userID)).rejects.toThrow("not eligible");
    await f.controller.reconcile(f.changeID);
    await f.controller.reconcile(f.changeID);
    expect(f.reviews).toHaveLength(1);
    expect(f.corrections).toHaveLength(0);
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
    expect((await f.controller.get(f.changeID))?.["reviewState"]).toBe("pending");
  } finally {
    await f.dispose();
  }
});
test("human approval records the exact completed review and newer source cannot reuse it", async () => {
  const f = await setup();
  try {
    await f.complete(passed);
    const [before] = await f.database
      .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`;
    expect(before).toBeUndefined();
    await f.native("approveDelivery", [f.changeID]);
    const [approval] = await f.database.client<{ review: string; sha: string }[]>`
      SELECT candidate_review_id AS review,commit_sha AS sha FROM factory.delivery_approval WHERE change_id=${f.changeID}`;
    expect(approval).toEqual({ review: f.reviewID, sha: f.commit });
    await observe(
      async () =>
        (
          await f.database.client<
            { state: string }[]
          >`SELECT state FROM factory.merge_operation WHERE change_id=${f.changeID}`
        )[0]?.state,
      (state) => state === "succeeded",
    );
  } finally {
    await f.dispose();
  }
});
test("a changed candidate needs new Verification and review, not the previous pass", async () => {
  const f = await setup();
  try {
    await f.complete(passed);
    const newer = "e".repeat(40);
    f.setHead(newer);
    await f.database.client`INSERT INTO factory.change_commit_operation(
      id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
      observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
      SELECT ${crypto.randomUUID()},id,runtime_attempt_id,2,branch_name,${f.commit},${newer},${newer},
        'Owned correction',${crypto.randomUUID()},'succeeded',created_by,now()
      FROM factory.change WHERE id=${f.changeID}`;
    await f.database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,created_by,state,completed_at)
      VALUES(${crypto.randomUUID()},${f.changeID},${newer},1,'owned-new-review',2,${f.userID},'succeeded',now())`;
    await expect(f.controller.approve(f.changeID, f.userID)).rejects.toThrow("not eligible");
    const replay = await createReviewAdmission(f.database)(f.changeID, f.reviewID, f.userID);
    expect(replay.replayed).toBe(true);
    expect(replay.turn.state).toBe("completed");
    await f.controller.reconcile(f.changeID);
    expect(f.reviews).toHaveLength(1);
    expect(
      await f.database
        .client`SELECT id FROM factory.candidate_review WHERE change_id=${f.changeID}`,
    ).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("changed Requirements cannot reuse a review of the earlier approved scope", async () => {
  const f = await setup();
  try {
    await f.complete(passed);
    const content = JSON.stringify({
      summary: "A new requirement",
      acceptanceCriteria: ["A different accepted behavior"],
      nonGoals: [],
    });
    await f.database
      .client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
      VALUES(${crypto.randomUUID()},${f.ticketID},2,${content},${createHash("sha256").update(content).digest("hex")},${f.userID})`;
    await expect(f.controller.approve(f.changeID, f.userID)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});
test("only reproducible blocking review findings feed one targeted correction", async () => {
  const f = await setup();
  try {
    await f.complete(
      candidateReviewResultInput.parse({
        ...passed,
        verdict: "changes-requested",
        summary: "Numeric addition is wrong.",
        criteria: [{ criterion: 1, status: "failed", evidence: "2+3 returned -1." }],
        findings: [
          {
            severity: "blocking",
            title: "Addition subtracts",
            path: "sum.ts",
            line: 1,
            explanation: "Expected 5, observed -1.",
            reproduction: "Call sum(2,3).",
          },
          {
            severity: "advisory",
            title: "Rename everything",
            explanation: "A personal preference.",
            reproduction: "Not a defect.",
          },
        ],
      }),
    );
    await f.controller.reconcile(f.changeID);
    await f.controller.reconcile(f.changeID);
    expect(f.corrections).toHaveLength(1);
    expect(f.corrections[0]).toContain("Call sum(2,3)");
    expect(f.corrections[0]).toContain("sum.ts:1");
    expect(f.corrections[0]).not.toContain("Rename everything");
    expect((await f.review())?.state).toBe("changes-requested");
  } finally {
    await f.dispose();
  }
});
test("explicit incomplete-review retry gets a fresh identity and does not rewrite or replay the first attempt", async () => {
  const f = await setup();
  try {
    await f.complete(null);
    const old = await f.review();
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    const commandID = crypto.randomUUID();
    await Promise.all([
      f.native("retryCandidateReview", [
        f.changeID,
        { commandId: commandID, reviewId: f.reviewID },
      ]),
      f.native("retryCandidateReview", [
        f.changeID,
        { commandId: commandID, reviewId: f.reviewID },
      ]),
    ]);
    await expect(
      f.native("retryCandidateReview", [
        f.changeID,
        { commandId: commandID, reviewId: crypto.randomUUID() },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.native("retryCandidateReview", [
        f.changeID,
        { commandId: crypto.randomUUID(), reviewId: f.reviewID },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.reviews).toHaveLength(1);
    const sessions = await f.database.client<{ session: string }[]>`SELECT session_id AS session
      FROM factory.change_agent_turn_intent intent JOIN factory.candidate_review review ON review.turn_id=intent.turn_id
      WHERE review.change_id=${f.changeID}`;
    expect(new Set(sessions.map((item) => item.session)).size).toBe(2);
    expect(await f.review()).toEqual(old);
    expect(await f.native("getDelivery", [f.changeID])).toMatchObject({ reviewState: "pending" });
    await expect(f.native("approveDelivery", [f.changeID])).rejects.toMatchObject({
      status: 403,
    });
  } finally {
    await f.dispose();
  }
});

test.each(["stopped", "failed", "cleanup-failed", "starting", "ready"] as const)(
  "review retry after bootstrap interruption only replaces settled compute: %s",
  async (runtimeState) => {
    const f = await setup();
    try {
      await f.complete(null);
      await f.database.client`UPDATE factory.change SET state='starting' WHERE id=${f.changeID}`;
      await f.database.client`UPDATE factory.runtime_attempt SET state=${runtimeState}
        WHERE id=${f.attemptID}`;
      await f.database
        .client`UPDATE factory.change_agent_session SET state='stopped',stop_pending=false
        WHERE change_id=${f.changeID}`;
      const commandID = crypto.randomUUID();
      if (["stopped", "failed"].includes(runtimeState)) {
        await f.controller.retryReview(f.changeID, f.userID, commandID, f.reviewID);
        expect(f.reviews).toHaveLength(1);
        const freshID = f.reviews[0];
        if (!freshID) throw new Error("Expected the new owned review turn");
        const fresh = await f.turns.get(freshID);
        expect(fresh?.command.kind).toBe("change-review");
        expect(fresh?.authority).toMatchObject({
          mode: "build",
          review: { commitSha: f.commit },
        });
      } else {
        await expect(
          f.controller.retryReview(f.changeID, f.userID, commandID, f.reviewID),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(f.reviews).toHaveLength(0);
      }
      expect(f.requests()).toBe(0);
      expect(f.corrections).toEqual([]);
      await expect(f.controller.approve(f.changeID, f.userID)).rejects.toThrow();
    } finally {
      await f.dispose();
    }
  },
);

test("automatic correction retains every compact finding rather than cutting feedback at the chat limit", async () => {
  const f = await setup();
  try {
    const findings = Array.from({ length: 5 }, (_, index) => ({
      severity: "blocking" as const,
      title: `Reproducible defect ${index + 1}`,
      explanation: "Observed behavior does not satisfy the approved criterion. ".repeat(30),
      reproduction: `Reproduce defect ${index + 1} using the approved action.`,
    }));
    await f.complete(
      candidateReviewResultInput.parse({
        ...passed,
        verdict: "changes-requested",
        summary: "Several within-scope defects.",
        criteria: [{ criterion: 1, status: "failed", evidence: "Observed the listed defects." }],
        findings,
      }),
    );
    await f.controller.reconcile(f.changeID);
    expect(f.corrections).toHaveLength(1);
    expect(f.corrections[0]!.length).toBeGreaterThan(8_000);
    expect(f.corrections[0]).toContain("Reproduce defect 5 using the approved action.");
    expect(f.corrections[0]).toEndWith(
      "Factory will submit the corrected candidate for new exact Verification and independent review.",
    );
  } finally {
    await f.dispose();
  }
});

test.each(["failed", "stopped"] as const)(
  "resuming a budget-paused %s reviewer never acquires implementation authority",
  async (state) => {
    const f = await setup();
    const agent = createAgentController(
      f.database,
      f.hub,
      { startPersisted: async () => null },
      undefined,
      f.writers,
    );
    try {
      const turn = await f.activeReview();
      await f.database
        .client`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${turn.id},'finish-reserve-used')`;
      if (state === "failed") {
        await f.turns.settle(
          turn.id,
          turn.ownerToken,
          "failed",
          "Coding allowance reached during review",
        );
        await f.database
          .client`UPDATE factory.change_agent_session SET state='failed' WHERE change_id=${f.changeID}`;
      } else await agent.stop(f.changeID);
      await expect(
        agent.resume(f.changeID, f.userID, crypto.randomUUID(), turn.id),
      ).rejects.toMatchObject({ code: "conflict" });
      await f.controller.retryReview(f.changeID, f.userID, crypto.randomUUID(), f.reviewID);
      const [pause] = await f.database.client<
        { resumed: string }[]
      >`SELECT resumed_by_turn_id AS resumed FROM factory.coding_pause WHERE turn_id=${turn.id}`;
      expect(pause?.resumed).toBe(f.reviews[0]);
      const fresh = await f.turns.get(f.reviews[0]!);
      expect(fresh?.command.kind).toBe("change-review");
      expect(fresh?.authority).toMatchObject({ mode: "build", review: { commitSha: f.commit } });
      expect(f.requests()).toBe(0);
    } finally {
      await agent.shutdown();
      await f.dispose();
    }
  },
);
