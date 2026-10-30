import { expect, test } from "bun:test";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

async function deliveryFixture() {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const sha = "d".repeat(40);
    await database.client`UPDATE factory.project SET repository_url = 'http://forge.invalid/owned/build.git'
      WHERE id = ${owned.projectID}`;
    await database.client`INSERT INTO factory.change_commit_operation(
      id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
      commit_sha, observed_remote_sha, commit_message, idempotency_key, state, created_by, completed_at)
      SELECT ${crypto.randomUUID()}, id, runtime_attempt_id, 1, branch_name, base_sha,
        ${sha}, ${sha}, 'Owned Delivery regression', ${crypto.randomUUID()}, 'succeeded', created_by, now()
      FROM factory.change WHERE id = ${owned.changeID}`;
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
      sha,
      forge,
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
        await database.client.end({ timeout: 0 });
        await process.dispose();
      },
    };
  } catch (cause) {
    await database.client.end({ timeout: 0 });
    await process.dispose();
    throw cause;
  }
}

test("failed Verification compute is visible while human editing fences reconciliation", async () => {
  const f = await deliveryFixture();
  const verificationID = crypto.randomUUID();
  const attemptID = crypto.randomUUID();
  const replacementID = crypto.randomUUID();
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
      id,change_id,commit_sha,pull_request_number,runner_name,state,action_run_id,created_by,runner_token)
      VALUES(${verificationID},${f.owned.changeID},${f.sha},1,'owned-startup-failure','runner-starting',1,${f.owned.userID},'owned-unused')`;
    await f.database.client`INSERT INTO factory.runtime_attempt(
      id,project_id,verification_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,failure)
      VALUES(${attemptID},${f.owned.projectID},${verificationID},'verification',2,${f.sha},'failed',
        ${"a".repeat(64)},${"b".repeat(64)},now(),${f.owned.userID},'no space left on device')`;
    await f.database
      .client`UPDATE factory.verification SET runtime_attempt_id=${attemptID} WHERE id=${verificationID}`;
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
    // A replacement's actual startup clears the old presentation without
    // rewriting the recorded Verification or manufacturing a passing result.
    await f.database.client`INSERT INTO factory.runtime_attempt(
      id,project_id,verification_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${replacementID},${f.owned.projectID},${verificationID},'verification',3,${f.sha},'starting',
        ${"c".repeat(64)},${"d".repeat(64)},now(),${f.owned.userID})`;
    await f.database
      .client`UPDATE factory.verification SET runtime_attempt_id=${replacementID} WHERE id=${verificationID}`;
    expect(await delivery.get(f.owned.changeID)).toMatchObject({
      verificationState: "runner-starting",
      verificationSummary: null,
      verificationFailureKind: null,
    });
    expect((await changes.get(f.owned.changeID))?.verificationState).toBe("runner-starting");
    // A native check result remains authoritative even if cleanup later fails.
    await f.database
      .client`UPDATE factory.verification SET state='succeeded',summary='Exact checks passed',completed_at=now() WHERE id=${verificationID}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='cleanup-failed',failure='cleanup failed' WHERE id=${replacementID}`;
    expect(await delivery.get(f.owned.changeID)).toMatchObject({
      verificationState: "succeeded",
      verificationSummary: "Exact checks passed",
      verificationFailureKind: null,
    });
    expect((await changes.get(f.owned.changeID))?.verificationState).toBe("succeeded");
    expect((await changes.list(f.owned.projectID, f.owned.userID))[0]?.verificationState).toBe(
      "succeeded",
    );
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
    const attemptID = crypto.randomUUID();
    const repairs: string[] = [];
    const reviews: string[] = [];
    const stops: string[] = [];
    let runnerRevoked = false;
    try {
      f.setStatus(status);
      await f.database.client`INSERT INTO factory.verification(
        id,change_id,commit_sha,pull_request_number,runner_name,state,action_run_id,created_by,
        runner_id,runner_uuid,runner_token)
        VALUES(${verificationID},${f.owned.changeID},${f.sha},1,'owned-cleanup-handoff','running',1,
          ${f.owned.userID},27,${crypto.randomUUID()},'owned-unused')`;
      await f.database.client`INSERT INTO factory.runtime_attempt(
        id,project_id,verification_id,isolated_kind,generation,revision,state,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${attemptID},${f.owned.projectID},${verificationID},'verification',2,${f.sha},'ready',
          ${"a".repeat(64)},${"b".repeat(64)},now(),${f.owned.userID})`;
      await f.database.client`UPDATE factory.verification SET runtime_attempt_id=${attemptID}
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
    const previous = crypto.randomUUID();
    const replacement = crypto.randomUUID();
    const verification = crypto.randomUUID();
    const approval = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.verification(id, change_id, commit_sha, pull_request_number, runner_name, state, action_run_id, created_by, completed_at)
      VALUES (${verification}, ${f.owned.changeID}, ${f.sha}, 1, 'owned-complete', 'succeeded', 1, ${f.owned.userID}, now())`;
    await f.database
      .client`INSERT INTO factory.delivery_approval(id, change_id, verification_id, commit_sha, approved_by)
      VALUES (${approval}, ${f.owned.changeID}, ${verification}, ${f.sha}, ${f.owned.userID})`;
    await f.database
      .client`INSERT INTO factory.merge_operation(id, change_id, delivery_approval_id, pull_request_number, base_sha, commit_sha, idempotency_key, state, observed_default_sha, completed_at)
      VALUES (${crypto.randomUUID()}, ${f.owned.changeID}, ${approval}, 1, ${"a".repeat(40)}, ${f.sha}, ${crypto.randomUUID()}, 'succeeded', ${f.sha}, now())`;
    for (const [id, revision, state, generation] of [
      [previous, "a".repeat(40), "ready", 2],
      [replacement, f.sha, "starting", 3],
    ] as const) {
      await f.database
        .client`INSERT INTO factory.runtime_attempt(id, project_id, isolated_kind, generation, revision, state, parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
        VALUES (${id}, ${f.owned.projectID}, 'staging', ${generation}, ${revision}, ${state}::factory.runtime_attempt_state, ${"a".repeat(64)}, ${"b".repeat(64)}, now(), ${f.owned.userID})`;
    }
    await f.database
      .client`INSERT INTO factory.staging_preview(project_id, revision, runtime_attempt_id) VALUES (${f.owned.projectID}, ${"a".repeat(40)}, ${previous})`;
    await f.database
      .client`INSERT INTO factory.promotion_operation(id, change_id, project_id, commit_sha, state, previous_runtime_attempt_id, replacement_runtime_attempt_id)
      VALUES (${crypto.randomUUID()}, ${f.owned.changeID}, ${f.owned.projectID}, ${f.sha}, 'starting', ${previous}, ${replacement})`;
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
  } finally {
    await f.close();
  }
}, 60_000);
