import { expect, test } from "bun:test";
import { deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { retryVerificationBootstrap } from "../../apps/factory/src/delivery/verification-retry";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";

async function deliveryFixture() {
  const process = await factoryProcess();
  const database = process.connect();
  let scope: Awaited<ReturnType<typeof candidateReviewFixture>> | undefined;
  let jobs: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
  const controllers = new Set<ReturnType<typeof createDeliveryController>>();
  try {
    const owned = await candidateReviewFixture(undefined, database);
    scope = owned;
    const sha = owned.commit;
    await database.client`DELETE FROM factory.candidate_review WHERE id=${owned.reviewID}`;
    await database.client`DELETE FROM factory.verification WHERE id=${owned.verificationID}`;
    await database.client`UPDATE factory.project SET repository_url = 'https://owned-build.factory.invalid/owned/build.git'
      WHERE id = ${owned.projectID}`;
    jobs = await nativeJobsFixture(database, owned.projectID);
    const native = jobs;
    await database.client`INSERT INTO factory.pull_request_operation(
      id, change_id, repository_owner, repository_name, base_branch, head_branch,
      first_head_sha, title, body, idempotency_key, state, pull_request_number, pull_request_url, completed_at)
      SELECT ${crypto.randomUUID()}, id, 'owned', 'build', 'main', branch_name, ${sha},
        'Owned', '', ${crypto.randomUUID()}, 'succeeded', 1, 'http://forge.invalid/pr/1', now()
      FROM factory.change WHERE id = ${owned.changeID}`;
    let head = sha;
    let base = "a".repeat(40);
    let status = "failure";
    const forge = {
      ...createForgejoClient({ apiURL: "http://127.0.0.1:9/api/v1/", token: "owned-unused" }),
      getPullRequest: async () => ({
        number: 1,
        url: "http://forge.invalid/pr/1",
        headSha: head,
        merged: false,
        state: "open",
        baseBranch: "main",
        baseSha: base,
        headBranch: "factory/owned",
      }),
      getDefaultBranch: async () => ({ name: "main", headSha: base }),
      getFile: async () => "owned protected workflow",
      listActionRuns: async () => [
        {
          id: 1,
          workflowID: "factory-verification.yml",
          event: "pull_request",
          status,
          commitSha: head,
          url: "http://forge.invalid/run/1",
        },
      ],
      diagnoseVerification: async () => ({
        kind: "check-failed" as const,
        summary: "Owned checks failed at the exact candidate.",
        jobs: [
          {
            id: 8,
            attempt: 1,
            name: "Checks",
            step: 1,
            stepName: "test",
            output: "Owned regression assertion failed.",
          },
        ],
      }),
    };
    return {
      process,
      database,
      owned,
      native,
      controllers,
      sha,
      forge,
      async approvedMerge() {
        await database.client`INSERT INTO factory.verification(
          id,change_id,commit_sha,pull_request_number,runner_name,state,action_run_id,created_by,completed_at)
          VALUES(${owned.verificationID},${owned.changeID},${sha},1,'owned-exact-promotion',
            'succeeded',1,${owned.userID},now())`;
        await database.client`INSERT INTO factory.candidate_review(
          id,verification_id,change_id,commit_sha,base_sha,created_by)
          VALUES(${owned.reviewID},${owned.verificationID},${owned.changeID},${sha},
            ${"a".repeat(40)},${owned.userID})`;
        const turn = await owned.activeReview();
        await owned.turns.settle(
          turn.id,
          turn.ownerToken,
          "completed",
          "Exact candidate passed",
          async (sql) => {
            await sql`UPDATE factory.candidate_review SET state='passed',result=${JSON.stringify({
              verdict: "passed",
              summary: "Owned exact source observation",
              criteria: [{ criterion: 1, status: "passed", evidence: "Owned candidate checked" }],
              findings: [],
              ui: "not-applicable",
            })}::jsonb,completed_at=now() WHERE id=${owned.reviewID}`;
            await sql`UPDATE factory.change_agent_session SET state='committed'
            WHERE change_id=${owned.changeID}`;
          },
        );
        const approval = crypto.randomUUID();
        await database.client`INSERT INTO factory.delivery_approval(
          id,change_id,verification_id,candidate_review_id,commit_sha,approved_by)
          VALUES(${approval},${owned.changeID},${owned.verificationID},${owned.reviewID},${sha},${owned.userID})`;
        await database.client`INSERT INTO factory.merge_operation(
          id,change_id,delivery_approval_id,pull_request_number,base_sha,commit_sha,
          idempotency_key,state,observed_default_sha,completed_at)
          VALUES(${crypto.randomUUID()},${owned.changeID},${approval},1,${"a".repeat(40)},
            ${sha},${crypto.randomUUID()},'succeeded',${sha},now())`;
        await database.client`UPDATE factory.change SET state='delivering' WHERE id=${owned.changeID}`;
      },
      setHead(value: string) {
        head = value;
      },
      setBase(value: string) {
        base = value;
      },
      setStatus(value: string) {
        status = value;
      },
      async close() {
        try {
          for (const controller of controllers) await controller.close();
          await native.close();
          await database.client.end({ timeout: 0 });
          await process.dispose();
        } finally {
          owned.restoreEnvironment();
        }
      },
    };
  } catch (cause) {
    try {
      await jobs?.close();
      await database.client.end({ timeout: 0 });
      await process.dispose();
    } finally {
      scope?.restoreEnvironment();
    }
    throw cause;
  }
}

test("failed Verification compute is visible while human editing fences reconciliation", async () => {
  const f = await deliveryFixture();
  const verificationID = crypto.randomUUID();
  const unavailable = async () => {
    throw new Error("Status reads must not start compute, inference or external mutations");
  };
  try {
    await f.database.client`INSERT INTO factory.branch_create_operation(
      id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,
      state,observed_head_sha,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','build',branch_name,base_sha,${crypto.randomUUID()},
        'succeeded',base_sha,now() FROM factory.change WHERE id=${f.owned.changeID}`;
    await f.database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,created_by,
      runner_uuid,runner_token,runner_job_handle)
      VALUES(${verificationID},${f.owned.changeID},${f.sha},1,'owned-startup-failure',1,
        ${f.owned.userID},${crypto.randomUUID()},'owned-unused','owned-startup-job')`;
    const attemptID = await f.native.startVerification(verificationID, f.owned.userID);
    await f.database
      .client`UPDATE factory.verification SET state='runner-starting' WHERE id=${verificationID}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='failed',failure='no space left on device'
      WHERE id=${attemptID}`;
    await f.database
      .client`UPDATE factory.change_writer SET state='human',user_id=${f.owned.userID},turn_id=NULL
      WHERE change_id=${f.owned.changeID}`;
    const config = {
      FACTORY_FORGEJO_API_URL: "https://forge.invalid/api/v1",
      FACTORY_FORGEJO_TOKEN: "owned",
      FACTORY_FORGEJO_OWNER: "owned",
    };
    const previous = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
    let changes: ReturnType<typeof createChangeController>;
    try {
      Object.assign(process.env, config);
      changes = createChangeController(
        f.database,
        { stop: unavailable },
        undefined,
        undefined,
        f.forge,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const delivery = createDeliveryController(
      f.database,
      { startVerification: unavailable, startStagingReplacement: unavailable, stop: unavailable },
      { prompt: unavailable },
      unavailable,
      { client: f.forge, owner: "owned" },
    );
    f.controllers.add(delivery);
    const beforeReads = f.native.calls.length;
    for (const state of ["failed", "cleanup-failed", "stopped"] as const) {
      await f.database
        .client`UPDATE factory.runtime_attempt SET state=${state}::factory.runtime_attempt_state WHERE id=${attemptID}`;
      expect(await delivery.get(f.owned.changeID)).toMatchObject({
        verificationState: "failed",
        verificationFailureKind: "execution-failed",
        verificationSummary: "no space left on device",
      });
      expect((await changes.get(f.owned.changeID))?.verificationState).toBe("failed");
      expect((await changes.list(f.owned.projectID, f.owned.userID))[0]?.verificationState).toBe(
        "failed",
      );
    }
    expect(f.native.calls).toHaveLength(beforeReads);
    // Only the explicit exact-job retry can select a successor. Reading the
    // human-owned checkout never cleans up, retries or rewrites the failed job.
    await f.native.stop(attemptID);
    await f.database.client`UPDATE factory.change_writer SET state='agent',user_id=NULL,
      turn_id=${f.owned.initial.id} WHERE change_id=${f.owned.changeID}`;
    await f.database.client`UPDATE factory.verification SET state='failed',completed_at=now(),
      diagnosis=${JSON.stringify({
        kind: "execution-failed",
        runtimeAttemptId: attemptID,
        summary: "no space left on device",
        jobs: [],
      })}::jsonb WHERE id=${verificationID}`;
    await retryVerificationBootstrap(
      f.database,
      f.owned.changeID,
      f.owned.userID,
      crypto.randomUUID(),
      verificationID,
      attemptID,
    );
    await f.database.client`UPDATE factory.verification SET runner_uuid=${crypto.randomUUID()},
      runner_token='owned-retry-token' WHERE id=${verificationID}`;
    const replacementID = await f.native.startVerification(verificationID, f.owned.userID);
    expect(replacementID).toBe(runtimeIdentity(verificationID, 2).attemptID);
    await f.database
      .client`UPDATE factory.verification SET state='runner-starting' WHERE id=${verificationID}`;
    await f.database
      .client`UPDATE factory.change_writer SET state='human',user_id=${f.owned.userID},
      turn_id=NULL WHERE change_id=${f.owned.changeID}`;
    const afterRetry = f.native.calls.length;
    expect(await delivery.get(f.owned.changeID)).toMatchObject({
      verificationState: "runner-starting",
      verificationSummary: null,
      verificationFailureKind: null,
      verificationPreparationFailure: null,
    });
    expect((await changes.get(f.owned.changeID))?.verificationState).toBe("runner-starting");
    const deliveryRead = async () => deliveryViewSchema.parse(await delivery.get(f.owned.changeID));
    // A predecessor's wait never describes the current exact Verification Attempt.
    await f.database.client`INSERT INTO factory.runtime_compute_wait(attempt_id,reason)
      VALUES(${attemptID},'compute-capacity')`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database.client`INSERT INTO factory.runtime_compute_wait(attempt_id,reason)
      VALUES(${replacementID},'compute-capacity')`;
    // Taking over editing makes an automatic check wait inactive.
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database.client`UPDATE factory.change_writer SET state='agent',user_id=NULL,
      turn_id=${f.owned.initial.id} WHERE change_id=${f.owned.changeID}`;
    for (const state of ["pending", "runner-starting"] as const) {
      await f.database
        .client`UPDATE factory.verification SET state=${state}::factory.verification_state WHERE id=${verificationID}`;
      expect(await deliveryRead()).toMatchObject({
        verificationId: verificationID,
        verificationState: state,
        verificationComputeWait: true,
        verificationPreparationFailure: undefined,
        verificationFailureKind: undefined,
        verificationSummary: undefined,
        checksStopId: undefined,
        checksRetryAttemptId: undefined,
        approvedAt: undefined,
      });
    }
    // A retained wait row cannot promise a fresh start after readiness or Stop intent.
    await f.database
      .client`UPDATE factory.runtime_attempt SET ready_at=now() WHERE id=${replacementID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database.client`UPDATE factory.runtime_attempt SET ready_at=NULL,stop_intended_at=now()
      WHERE id=${replacementID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database
      .client`UPDATE factory.runtime_attempt SET stop_intended_at=NULL WHERE id=${replacementID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(true);
    // Read projection only. Stop, cancellation and inactive work do not promise an automatic start.
    const checksStopID = crypto.randomUUID();
    await f.database
      .client`UPDATE factory.change_agent_session SET state='stopped',stop_pending=true,stop_id=${checksStopID}
      WHERE change_id=${f.owned.changeID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database
      .client`UPDATE factory.change_agent_session SET stop_pending=false WHERE change_id=${f.owned.changeID}`;
    expect(await deliveryRead()).toMatchObject({
      verificationComputeWait: false,
      checksStopId: checksStopID,
    });
    await f.database.client`UPDATE factory.change_agent_session SET state='committed',stop_id=NULL
      WHERE change_id=${f.owned.changeID}`;
    await f.database
      .client`UPDATE factory.change SET cancel_requested_at=now() WHERE id=${f.owned.changeID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database
      .client`UPDATE factory.change SET cancel_requested_at=NULL,state='failed' WHERE id=${f.owned.changeID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database.client`UPDATE factory.change SET state='active' WHERE id=${f.owned.changeID}`;
    await f.database
      .client`UPDATE factory.ticket SET trashed_at=now() WHERE id=${f.owned.ticketID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database.client`UPDATE factory.ticket SET trashed_at=NULL WHERE id=${f.owned.ticketID}`;
    await f.database.client`UPDATE factory.runtime_compute_wait SET reason='accounting-incomplete'
      WHERE attempt_id=${replacementID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(false);
    await f.database.client`UPDATE factory.runtime_compute_wait SET reason='compute-capacity'
      WHERE attempt_id=${replacementID}`;
    for (const state of ["running", "cancelled", "succeeded"] as const) {
      await f.database
        .client`UPDATE factory.verification SET state=${state}::factory.verification_state,
        completed_at=CASE WHEN ${state !== "running"} THEN now() END WHERE id=${verificationID}`;
      expect((await deliveryRead()).verificationComputeWait).toBe(false);
    }
    await f.database
      .client`UPDATE factory.verification SET state='runner-starting',completed_at=NULL WHERE id=${verificationID}`;
    expect((await deliveryRead()).verificationComputeWait).toBe(true);
    for (const state of ["failed", "cleanup-failed", "stopped"] as const) {
      await f.database.client`UPDATE factory.runtime_attempt
        SET state=${state}::factory.runtime_attempt_state,failure='Check environment could not start'
        WHERE id=${replacementID}`;
      expect(await deliveryRead()).toMatchObject({
        verificationState: "failed",
        verificationComputeWait: false,
        verificationFailureKind: "execution-failed",
        verificationSummary: "Check environment could not start",
      });
    }
    await f.database.client`UPDATE factory.runtime_attempt SET state='starting',failure=NULL
      WHERE id=${replacementID}`;
    const preparationIssue = "Native WorkerPool capacity refused preparation before dispatch";
    await f.database
      .client`UPDATE factory.runtime_attempt SET failure=${preparationIssue} WHERE id=${replacementID}`;
    expect(await delivery.get(f.owned.changeID)).toMatchObject({
      verificationState: "runner-starting",
      verificationFailureKind: null,
      verificationPreparationFailure: preparationIssue,
      verificationComputeWait: false,
    });
    // Historical diagnostics must not override actual readiness or check outcomes.
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${replacementID}`;
    expect(await delivery.get(f.owned.changeID)).toMatchObject({
      verificationState: "runner-starting",
      verificationPreparationFailure: null,
      verificationComputeWait: false,
    });
    // A native check result remains authoritative even if cleanup later fails.
    await f.database
      .client`UPDATE factory.verification SET state='succeeded',summary='Exact checks passed',completed_at=now() WHERE id=${verificationID}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='cleanup-failed',failure='cleanup failed' WHERE id=${replacementID}`;
    expect(await delivery.get(f.owned.changeID)).toMatchObject({
      verificationState: "succeeded",
      verificationSummary: "Exact checks passed",
      verificationFailureKind: null,
      verificationComputeWait: false,
    });
    expect((await changes.get(f.owned.changeID))?.verificationState).toBe("succeeded");
    expect((await changes.list(f.owned.projectID, f.owned.userID))[0]?.verificationState).toBe(
      "succeeded",
    );
    await f.database
      .client`UPDATE factory.change_writer SET state='human',user_id=${f.owned.userID},turn_id=NULL
      WHERE change_id=${f.owned.changeID}`;
    const [writer] = await f.database
      .client`SELECT state,user_id FROM factory.change_writer WHERE change_id=${f.owned.changeID}`;
    expect(writer).toEqual({ state: "human", user_id: f.owned.userID });
    const [original] = await f.database
      .client`SELECT state,failure FROM factory.runtime_attempt WHERE id=${attemptID}`;
    expect(original).toEqual({ state: "stopped", failure: "no space left on device" });
    expect(
      await f.database
        .client`SELECT id FROM factory.runtime_attempt WHERE verification_id=${verificationID}`,
    ).toHaveLength(2);
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.owned.changeID}`,
    ).toHaveLength(0);
    expect(f.native.calls).toHaveLength(afterRetry);
  } finally {
    await f.close();
  }
}, 60_000);

test("failed exact Verification requests one bounded repair on the same Change", async () => {
  const f = await deliveryFixture();
  const prompts: Array<{
    changeID: string;
    text: string;
    userID: string;
    commandID: string;
    repair: boolean | undefined;
  }> = [];
  try {
    const controller = createDeliveryController(
      f.database,
      {
        startVerification: async () => {
          throw new Error("Completed failed run must not start compute");
        },
        startStagingReplacement: async () => null,
        stop: async () => null,
      },
      {
        prompt: async (changeID, text, userID, commandID, repair) => {
          prompts.push({ changeID, text, userID, commandID, repair });
        },
      },
      async () => {},
      { client: f.forge, owner: "owned" },
    );
    f.controllers.add(controller);
    await controller.reconcile(f.owned.changeID);
    await controller.reconcile(f.owned.changeID);
    const [verification] = await f.database.client<
      { id: string; state: string; sha: string; repaired: boolean }[]
    >`
      SELECT id, state, commit_sha AS sha, repair_prompted_at IS NOT NULL AS repaired
      FROM factory.verification WHERE change_id = ${f.owned.changeID}`;
    expect(verification).toMatchObject({ state: "failed", sha: f.sha, repaired: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      changeID: f.owned.changeID,
      userID: f.owned.userID,
      commandID: verification?.id,
      repair: true,
    });
    expect(prompts[0]?.text).toContain(f.sha.slice(0, 12));
    expect(prompts[0]?.text).toContain("without committing or pushing");
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id = ${f.owned.changeID}`,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["failure", "success"] as const)(
  "exact %s Verification waits for compute cleanup and runner revocation before its handoff",
  async (status) => {
    const f = await deliveryFixture();
    const verificationID = crypto.randomUUID();
    const repairs: string[] = [];
    const reviews: string[] = [];
    const stops: string[] = [];
    let runnerRevoked = false;
    try {
      f.setStatus(status);
      await f.database.client`INSERT INTO factory.verification(
        id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,created_by,
        runner_id,runner_uuid,runner_token,runner_job_handle)
        VALUES(${verificationID},${f.owned.changeID},${f.sha},1,'owned-cleanup-handoff',1,
          ${f.owned.userID},27,${crypto.randomUUID()},'owned-unused','owned-cleanup-job')`;
      const attemptID = await f.native.startVerification(verificationID, f.owned.userID);
      await f.database.client`UPDATE factory.verification SET state='running'
        WHERE id=${verificationID}`;
      const controller = createDeliveryController(
        f.database,
        {
          startVerification: async () => {
            throw new Error("Completed checks must not commission more compute");
          },
          startStagingReplacement: async () => null,
          stop: async (id) => {
            stops.push(id);
            await f.database.client`UPDATE factory.runtime_attempt
              SET stop_intended_at=COALESCE(stop_intended_at,now()),state='stop-intended'
              WHERE id=${id}`;
            return null;
          },
        },
        {
          prompt: async (_changeID, _text, _userID, commandID) => {
            repairs.push(commandID);
          },
          review: async (_changeID, reviewID) => {
            reviews.push(reviewID);
          },
        },
        async () => {},
        {
          client: {
            ...f.forge,
            deleteRunner: async () => {
              if (!runnerRevoked) throw new Error("Owned runner revocation is unconfirmed");
            },
            observeVerification: async () => ({
              status: "success",
              complete: false,
              jobs: [],
              changes: null,
            }),
          } as unknown as ReturnType<typeof createForgejoClient>,
          owner: "owned",
        },
      );
      f.controllers.add(controller);
      try {
        for (const state of ["ready", "stop-intended", "stopping", "cleanup-failed"] as const) {
          await f.database.client`UPDATE factory.runtime_attempt SET state=${state}
            WHERE id=${attemptID}`;
          await controller.reconcile(f.owned.changeID);
          expect(repairs).toEqual([]);
          expect(reviews).toEqual([]);
          expect(
            await f.database.client`SELECT id FROM factory.verification
              WHERE id=${verificationID} AND state=${status === "success" ? "succeeded" : "failed"}
                AND repair_prompted_at IS NULL AND runner_id=27`,
          ).toHaveLength(1);
        }
        await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now()
          WHERE id=${attemptID}`;
        await controller.reconcile(f.owned.changeID);
        expect(repairs).toEqual([]);
        expect(reviews).toEqual([]);
        runnerRevoked = true;
        await controller.reconcile(f.owned.changeID);
        expect(repairs).toEqual([]);
        expect(reviews).toEqual([]);
        expect(
          await f.database.client`SELECT runtime_attempt_id FROM factory.substrate_binding
          WHERE runtime_attempt_id=${attemptID} AND deleted_at IS NULL`,
        ).toHaveLength(1);
        await f.native.stop(attemptID);
        await controller.reconcile(f.owned.changeID);
        if (status === "failure") await controller.reconcile(f.owned.changeID);
        expect(repairs).toEqual(status === "failure" ? [verificationID] : []);
        expect(reviews).toHaveLength(status === "success" ? 1 : 0);
        expect(stops).toEqual([attemptID]);
      } finally {
        await controller.close();
      }
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.each(["head", "base"] as const)(
  "exact human delivery rejects moving %s",
  async (moved) => {
    const f = await deliveryFixture();
    try {
      f.setStatus("success");
      const controller = createDeliveryController(
        f.database,
        {
          startVerification: async () => null,
          startStagingReplacement: async () => null,
          stop: async () => null,
        },
        {
          prompt: async () => {
            throw new Error("Green run must not repair");
          },
        },
        async () => {},
        { client: f.forge, owner: "owned" },
      );
      f.controllers.add(controller);
      await controller.reconcile(f.owned.changeID);
      if (moved === "head") f.setHead("e".repeat(40));
      else f.setBase("e".repeat(40));
      await expect(controller.approve(f.owned.changeID, f.owned.userID)).rejects.toThrow(
        "Current commit is not eligible for delivery",
      );
      expect(
        await f.database
          .client`SELECT id FROM factory.delivery_approval WHERE change_id = ${f.owned.changeID}`,
      ).toHaveLength(0);
      expect(
        await f.database
          .client`SELECT id FROM factory.merge_operation WHERE change_id = ${f.owned.changeID}`,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("promotion retains the healthy Staging while starting, then retries only owned cleanup", async () => {
  const f = await deliveryFixture();
  try {
    await f.database.client`INSERT INTO factory.staging_preview(project_id,revision)
      VALUES(${f.owned.projectID},${"a".repeat(40)})`;
    const previous = await f.native.startStaging(f.owned.userID);
    await f.database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${previous}`;
    await f.approvedMerge();
    const promotion = crypto.randomUUID();
    await f.database.client`INSERT INTO factory.promotion_operation(
      id,change_id,project_id,commit_sha,previous_runtime_attempt_id)
      VALUES(${promotion},${f.owned.changeID},${f.owned.projectID},${f.sha},${previous})`;
    const replacement = await f.native.startStaging(f.owned.userID, promotion);
    const stopped: string[] = [];
    const retired: string[] = [];
    let failed = false;
    const controller = createDeliveryController(
      f.database,
      {
        startVerification: async () => null,
        startStagingReplacement: async () => null,
        stop: async (id) => {
          stopped.push(id);
          if (!failed) {
            failed = true;
            throw new Error("Owned cleanup response lost");
          }
          if (id !== f.owned.attemptID) await f.native.stop(id);
          return null;
        },
      },
      { prompt: async () => null },
      async (id) => {
        retired.push(id);
      },
      {
        client: f.forge,
        owner: "owned",
      },
    );
    f.controllers.add(controller);
    await controller.reconcile(f.owned.changeID);
    const [before] = await f.database.client<
      { id: string }[]
    >`SELECT runtime_attempt_id AS id FROM factory.staging_preview WHERE project_id = ${f.owned.projectID}`;
    expect(before?.id).toBe(previous);
    expect(stopped).toEqual([]);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state = 'ready' WHERE id = ${replacement}`;
    await controller.reconcile(f.owned.changeID);
    const [switched] = await f.database.client<
      { id: string; sha: string }[]
    >`SELECT runtime_attempt_id AS id, revision AS sha FROM factory.staging_preview WHERE project_id = ${f.owned.projectID}`;
    expect(switched).toEqual({ id: replacement, sha: f.sha });
    expect((await controller.get(f.owned.changeID))?.["cleanupError"]).toBe(
      "Owned cleanup response lost",
    );
    await controller.reconcile(f.owned.changeID);
    expect((await controller.get(f.owned.changeID))?.["cleanupError"]).toBeNull();
    expect(stopped).toEqual([previous, previous, f.owned.attemptID]);
    expect(stopped).not.toContain(replacement);
    expect(retired).toEqual([f.owned.changeID]);
    const [deleted] = await f.database.client`
      SELECT deleted_at IS NOT NULL AS confirmed FROM factory.substrate_binding
      WHERE runtime_attempt_id=${previous}`;
    expect(deleted).toEqual({ confirmed: true });
  } finally {
    await f.close();
  }
}, 60_000);

test("failed Promotion retry preserves its original attempt and admits one new exact-commit Start", async () => {
  const f = await deliveryFixture();
  try {
    const promotion = crypto.randomUUID();
    const command = crypto.randomUUID();
    const replacement = runtimeIdentity(command, 1).attemptID;
    await f.database.client`INSERT INTO factory.staging_preview(project_id,revision)
      VALUES(${f.owned.projectID},${"a".repeat(40)})`;
    const previous = await f.native.startStaging(f.owned.userID);
    await f.database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${previous}`;
    await f.approvedMerge();
    await f.database.client`INSERT INTO factory.promotion_operation(
      id,change_id,project_id,commit_sha,previous_runtime_attempt_id)
      VALUES(${promotion},${f.owned.changeID},${f.owned.projectID},${f.sha},${previous})`;
    const failed = await f.native.startStaging(f.owned.userID, promotion);
    await f.database.client`UPDATE factory.runtime_attempt SET state='failed',
      failure='missing Main-Preview configuration' WHERE id=${failed}`;
    await f.database.client`UPDATE factory.promotion_operation SET state='failed',
      last_error='Replacement Staging failed before readiness',completed_at=now() WHERE id=${promotion}`;
    const [original] = await f.database
      .client`SELECT * FROM factory.promotion_operation WHERE id=${promotion}`;
    if (!original) throw new Error("Missing original failed Promotion fixture");
    const starts: string[] = [];
    const stops: string[] = [];
    const controller = createDeliveryController(
      f.database,
      {
        startVerification: async () => {
          throw new Error("Retry must not repeat Verification");
        },
        startStagingReplacement: async (id, userID) => {
          const [intent] = await f.database.client`SELECT commit_sha,previous_runtime_attempt_id
            FROM factory.promotion_operation WHERE id=${id}`;
          expect(intent).toMatchObject({
            commit_sha: f.sha,
            previous_runtime_attempt_id: previous,
          });
          starts.push(id);
          expect(await f.native.startStaging(userID, id)).toBe(replacement);
          return null;
        },
        stop: async (id) => {
          stops.push(id);
          if (id !== f.owned.attemptID) await f.native.stop(id);
          return null;
        },
      },
      {
        prompt: async () => {
          throw new Error("Retry must not repeat Coding or Review");
        },
      },
      async () => {},
      { client: f.forge, owner: "owned" },
    );
    f.controllers.add(controller);
    expect(typeof controller.retryPromotion).toBe("function");
    for (const state of ["starting", "ready", "pausing", "stopping", "cleanup-failed"]) {
      await f.database.client`UPDATE factory.runtime_attempt
        SET state=${state}::factory.runtime_attempt_state WHERE id=${failed}`;
      await expect(
        controller.retryPromotion(f.owned.changeID, f.owned.userID, command, promotion),
      ).rejects.toThrow("cleanup are confirmed");
    }
    // A terminal product state alone cannot confirm original Actor deletion.
    await f.database.client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${failed}`;
    await expect(
      controller.retryPromotion(f.owned.changeID, f.owned.userID, command, promotion),
    ).rejects.toThrow("cleanup are confirmed");
    await f.native.stop(failed);
    await f.database.client`UPDATE factory.staging_preview SET runtime_attempt_id=${failed}
      WHERE project_id=${f.owned.projectID}`;
    await expect(
      controller.retryPromotion(f.owned.changeID, f.owned.userID, command, promotion),
    ).rejects.toThrow("Main Preview changed");
    await f.database.client`UPDATE factory.staging_preview SET runtime_attempt_id=${previous}
      WHERE project_id=${f.owned.projectID}`;
    f.setBase("e".repeat(40));
    await expect(
      controller.retryPromotion(f.owned.changeID, f.owned.userID, command, promotion),
    ).rejects.toThrow("default branch");
    expect(starts).toEqual([]);
    f.setBase(f.sha);
    await Promise.all([
      controller.retryPromotion(f.owned.changeID, f.owned.userID, command, promotion),
      controller.retryPromotion(f.owned.changeID, f.owned.userID, command, promotion),
    ]);
    await controller.reconcile(f.owned.changeID);
    await eventually(
      () => controller.get(f.owned.changeID),
      (row) => row?.["promotionState"] === "starting",
      "The explicit native Promotion retry did not retain its replacement",
    );
    expect(starts).toEqual([command]);
    expect((await controller.get(f.owned.changeID))?.["promotionId"]).toBe(command);
    expect((await controller.get(f.owned.changeID))?.["promotionState"]).toBe("starting");
    expect(
      (await f.database.client`SELECT * FROM factory.promotion_operation WHERE id=${promotion}`)[0],
    ).toEqual(original);
    expect(
      (
        await f.database.client`SELECT runtime_attempt_id FROM factory.staging_preview
      WHERE project_id=${f.owned.projectID}`
      )[0]?.["runtime_attempt_id"],
    ).toBe(previous);
    expect(stops).toEqual([]);
    await controller.retryPromotion(f.owned.changeID, f.owned.userID, command, promotion);
    expect(starts).toEqual([command]);
    await expect(
      controller.retryPromotion(f.owned.changeID, f.owned.userID, crypto.randomUUID(), promotion),
    ).rejects.toThrow("Promotion changed");
    await expect(
      controller.retryPromotion(f.owned.changeID, f.owned.userID, command, command),
    ).rejects.toThrow("retry changed target");
    const resetOriginal = async () => {
      await f.database
        .client`UPDATE factory.promotion_operation SET state='pending',completed_at=NULL
        WHERE id=${promotion}`;
    };
    await expect(resetOriginal()).rejects.toThrow("terminal outcome are immutable");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${replacement}`;
    await controller.reconcile(f.owned.changeID);
    expect((await controller.get(f.owned.changeID))?.["promotionState"]).toBe("succeeded");
    expect(
      (
        await f.database.client`SELECT runtime_attempt_id FROM factory.staging_preview
      WHERE project_id=${f.owned.projectID}`
      )[0]?.["runtime_attempt_id"],
    ).toBe(replacement);
    expect(stops).not.toContain(failed);
    expect(
      (await f.database.client`SELECT * FROM factory.promotion_operation WHERE id=${promotion}`)[0],
    ).toEqual(original);
    expect(
      await f.database.client`SELECT state,failure FROM factory.runtime_attempt WHERE id=${failed}`,
    ).toMatchObject([{ state: "stopped", failure: "missing Main-Preview configuration" }]);
  } finally {
    await f.close();
  }
}, 60_000);
