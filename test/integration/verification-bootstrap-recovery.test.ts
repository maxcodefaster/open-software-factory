import { expect, test } from "bun:test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { createDeliveryService } from "../../apps/factory/src/delivery/service";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createWorkspaceSubmission } from "../../apps/factory/src/workspace/submission";
import type { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";
import {
  compiledFactoryEndpoint,
  decodeFactoryResponse,
  factoryFunctionRequest,
} from "../fixtures/server-functions";

async function stoppedCodingCandidate(database: ReturnType<typeof createDatabase>) {
  const f = await fixture(undefined, undefined, database);
  const turns = createAgentTurnStore(database);
  const admitted = await createChangeAdmission(database, buildModelID).admit(f.changeID, f.userID, {
    kind: "change-start",
    commandId: crypto.randomUUID(),
  });
  const claimed = await turns.claimPending(admitted.turn.id);
  if (!claimed?.ownerToken) throw new Error("Missing owned Coding lease");
  await f.writers.prepareAgent(f.changeID, claimed.id);
  await turns.beginDispatch(claimed.id, claimed.ownerToken);
  await database.client`UPDATE factory.agent_turn SET state='stopped',
    outcome_summary='Owned G1 Coding stopped',owner_token=NULL,owner_expires_at=NULL
    WHERE id=${claimed.id} AND owner_token=${claimed.ownerToken} AND state='dispatching'`;
  await database.client`UPDATE factory.change_agent_session SET active_turn_id=${claimed.id}
    WHERE change_id=${f.changeID}`;
  return {
    ...f,
    turns,
    initial: admitted.turn,
    commit: "a".repeat(40),
    verificationID: crypto.randomUUID(),
    reviewID: crypto.randomUUID(),
  };
}

async function setup(integrations = 0, human?: "retained-session" | "absent-session") {
  const host = await factoryProcess();
  const database = host.connect();
  let owned: { restoreEnvironment(): void } | undefined;
  let native: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
  try {
    const f = human
      ? await stoppedCodingCandidate(database)
      : await candidateReviewFixture(undefined, database);
    owned = f;
    let commit = f.commit;
    let submittedID = f.initial.id;
    const stopID = crypto.randomUUID();
    const workspaceAttemptID = human ? runtimeIdentity(f.workspaceID, 2).attemptID : f.attemptID;
    if (human) {
      await database.client`DELETE FROM factory.candidate_review WHERE id=${f.reviewID}`;
      await database.client`DELETE FROM factory.verification WHERE id=${f.verificationID}`;
      await database.client`UPDATE factory.change_agent_session SET state='stopped',
        stop_id=${stopID},stop_turn_id=${f.initial.id},stop_pending=false,updated_at=clock_timestamp()
        WHERE change_id=${f.changeID}`;
      await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${f.attemptID}`;
      await database.client`UPDATE factory.substrate_binding SET delete_intended_at=now(),deleted_at=now()
        WHERE runtime_attempt_id=${f.attemptID}`;
      await database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,
          generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          VALUES(${workspaceAttemptID},${f.projectID},${f.changeID},${f.workspaceID},2,${f.commit},
            'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
        await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
          SELECT ${workspaceAttemptID},${`fa-${workspaceAttemptID.replaceAll("-", "")}`},
            ${`runtime-${workspaceAttemptID.replaceAll("-", "")}`},intent
          FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
        await freezeRuntimeEnvironment(sql, workspaceAttemptID);
        await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${workspaceAttemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${workspaceAttemptID} WHERE id=${f.changeID}`;
      });
      await database.client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},
        turn_id=NULL,epoch=epoch+1,fence_required=false,fence_attempt_id=NULL WHERE change_id=${f.changeID}`;
      if (human === "absent-session")
        await database.client`DELETE FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      commit = "e".repeat(40);
      submittedID = crypto.randomUUID();
      let remote = f.commit;
      const submission = createWorkspaceSubmission(
        database,
        {
          connected: (id) => id === workspaceAttemptID,
          parentOperation: async (_id, input, beforeSend) => {
            await beforeSend?.(() => {});
            if (input.action === "git-push") remote = commit;
            return { commitSHA: commit, remoteSHA: remote };
          },
        },
        { assertSaved: async () => {} },
        { getBranch: async () => ({ name: "branch", headSha: remote }) },
        { username: "factory-control", password: "owned-fixture" },
        { fenceSource: async () => {}, protect: async () => {} },
      );
      try {
        expect(
          await submission.submit(f.userID, {
            requestID: submittedID,
            workspaceID: f.workspaceID,
            expectedHead: f.commit,
            expectedRemoteHead: f.commit,
            message: "Submit saved G2 human implementation",
          }),
        ).toMatchObject({ state: "succeeded", commitSHA: commit, attemptID: workspaceAttemptID });
      } finally {
        await submission.close();
      }
      // Initial Delivery publication has already admitted this human candidate.
      // Keep G1 native/turn/Stop identity while seeding that recorded state.
      await database.client`UPDATE factory.change_agent_session SET state='committed'
        WHERE change_id=${f.changeID}`;
      await database.client`INSERT INTO factory.verification(
        id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,created_by)
        VALUES(${f.verificationID},${f.changeID},${commit},1,'owned-human-bootstrap',1,${f.userID})`;
    }
    for (let index = 0; index < integrations; index++) {
      const next = String(index + 3).repeat(40);
      await database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
        integration_base_sha,merge_parent_sha,commit_sha,observed_remote_sha,
        commit_message,idempotency_key,state,created_by,completed_at,source)
        SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,
          (SELECT max(sequence)+1 FROM factory.change_commit_operation WHERE change_id=${f.changeID}),branch_name,
          ${commit},${String(index + 5).repeat(40)},${String(index + 5).repeat(40)},
          ${next},${next},'Integrate current main',${crypto.randomUUID()},'succeeded',
          created_by,now(),'integration'
        FROM factory.change_commit_operation WHERE id=${submittedID}`;
      commit = next;
    }
    await database.client`DELETE FROM factory.candidate_review WHERE id=${f.reviewID}`;
    await database.client`UPDATE factory.verification SET state='pending',commit_sha=${commit},
      summary=NULL,completed_at=NULL,runner_id=16,runner_uuid=${crypto.randomUUID()},
      runner_token='owned-bootstrap-token',runner_job_handle='owned-bootstrap-job'
      WHERE id=${f.verificationID}`;
    native = await nativeJobsFixture(database, f.projectID);
    const jobs = native;
    const attemptID = await jobs.startVerification(f.verificationID, f.userID);
    await database.client`UPDATE factory.runtime_attempt SET state='failed',
      failure='Dev Container postCreateCommand failed: owned browser download failed'
      WHERE id=${attemptID}`;
    await database.client`INSERT INTO factory.pull_request_operation(
      id,change_id,repository_owner,repository_name,base_branch,head_branch,first_head_sha,
      title,body,idempotency_key,state,pull_request_number,pull_request_url,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','review','main',branch_name,${f.commit},
        'Owned bootstrap recovery','','owned-'||id,'succeeded',1,
        'https://forge.invalid/owned/review/pulls/1',now()
      FROM factory.change WHERE id=${f.changeID}`;
    let registrations = 0;
    let starts = 0;
    let continuations = 0;
    let prompts = 0;
    let observations = 0;
    let cleanup = true;
    let revoke = true;
    let actionState = "waiting";
    let registrationGate: (() => Promise<void>) | undefined;
    const stopped: string[] = [];
    const removed: number[] = [];
    const reviews: string[] = [];
    const forge = {
      ...createForgejoClient({ apiURL: "http://127.0.0.1:9/api/v1/", token: "owned-unused" }),
      getPullRequest: async () => ({
        number: 1,
        headSha: commit,
        merged: false,
        state: "open",
        url: "https://forge.invalid/owned/review/pulls/1",
        baseBranch: "main",
        baseSha: "a".repeat(40),
        headBranch: "factory/owned",
      }),
      getDefaultBranch: async () => ({ name: "main", headSha: "a".repeat(40) }),
      getFile: async () => "owned protected workflow",
      listActionRuns: async () => {
        observations++;
        return [
          {
            id: 1,
            workflowID: "factory-verification.yml",
            event: "pull_request",
            commitSha: commit,
            status: actionState,
            url: "https://forge.invalid/owned/review/actions/runs/1",
          },
        ];
      },
      registerEphemeralRunner: async () => {
        registrations++;
        await registrationGate?.();
        return { id: 17, uuid: crypto.randomUUID(), token: "owned-retry-token" };
      },
      deleteRunner: async (_repository: unknown, id: number) => {
        if (!revoke) throw new Error("Owned revocation not confirmed");
        removed.push(id);
      },
    };
    const controller = createDeliveryController(
      database,
      {
        startVerification: async () => {
          continuations++;
          const [current] = await database.client<{ id: string | null }[]>`
            SELECT runtime_attempt_id AS id FROM factory.verification WHERE id=${f.verificationID}`;
          if (!current?.id) starts++;
          await jobs.startVerification(f.verificationID, f.userID);
          return null;
        },
        startStagingReplacement: async () => null,
        stop: async (id) => {
          stopped.push(id);
          if (cleanup) await jobs.stop(id);
          else
            await database.client`UPDATE factory.runtime_attempt SET state='stopping',
              stop_intended_at=COALESCE(stop_intended_at,now()),failure='Owned cleanup unconfirmed'
              WHERE id=${id}`;
          return null;
        },
      },
      {
        review: async (changeID, reviewID, userID) => {
          const admitted = await createReviewAdmission(database)(changeID, reviewID, userID);
          if (!admitted.replayed) reviews.push(admitted.turn.id);
        },
        prompt: async () => {
          prompts++;
        },
      },
      async () => {},
      { client: forge, owner: "owned" },
    );
    const origin = "https://owned-bootstrap.test";
    const endpoint = await compiledFactoryEndpoint({
      origin,
      session: async () => ({ user: { id: f.userID } }),
      maintenance: async () => false,
      requireFresh: async () => {},
      services: {
        delivery: createDeliveryService({ access: createAccessController(database), controller }),
      } as unknown as FactoryServices,
    });
    return {
      ...f,
      commit,
      host,
      controller,
      submittedID,
      workspaceAttemptID,
      stopID,
      bootstrapAttemptID: attemptID,
      stopped,
      removed,
      reviews,
      jobs,
      counts: () => ({ registrations, starts, prompts }),
      continuations: () => continuations,
      observations: () => observations,
      setCleanup(value: boolean) {
        cleanup = value;
      },
      setRevocation(value: boolean) {
        revoke = value;
      },
      setActionState(value: string) {
        actionState = value;
      },
      holdRegistration(value: () => Promise<void>) {
        registrationGate = value;
      },
      async nativeRetry(commandId: string, runtimeAttemptId = attemptID) {
        return decodeFactoryResponse(
          await endpoint(
            await factoryFunctionRequest(origin, "resumeVerification", [
              f.changeID,
              { commandId, verificationId: f.verificationID, runtimeAttemptId },
            ]),
          ),
        );
      },
      async nativeResume(commandId: string, targetStopID = stopID) {
        return decodeFactoryResponse(
          await endpoint(
            await factoryFunctionRequest(origin, "resumeVerification", [
              f.changeID,
              { commandId, verificationId: f.verificationID, stopId: targetStopID },
            ]),
          ),
        );
      },
      async identities() {
        const [identity] = await database.client`
          SELECT
            (SELECT jsonb_agg(to_jsonb(session)-'updated_at'-'state'-'last_error')
              FROM factory.change_agent_session session WHERE change_id=${f.changeID}) AS session,
            (SELECT jsonb_agg(to_jsonb(submission)) FROM factory.workspace_submission submission
              WHERE id=${submittedID}) AS submission,
            (SELECT jsonb_agg(to_jsonb(operation)) FROM factory.change_commit_operation operation
              WHERE id=${submittedID}) AS operation,
            (SELECT jsonb_agg(to_jsonb(turn)) FROM factory.agent_turn turn
              WHERE change_id=${f.changeID}) AS turns`;
        return identity;
      },
      async row() {
        const [row] = await database.client<
          {
            state: string;
            runtime: string | null;
            runner: string | null;
            diagnosis: unknown;
          }[]
        >`SELECT state,runtime_attempt_id AS runtime,runner_id AS runner,diagnosis
          FROM factory.verification WHERE id=${f.verificationID}`;
        if (!row) throw new Error("Owned Verification missing");
        return row;
      },
      async close() {
        try {
          await controller.close();
          await jobs.close();
          await database.client.end({ timeout: 0 });
          await host.dispose();
        } finally {
          f.restoreEnvironment();
        }
      },
    };
  } catch (cause) {
    try {
      await native?.close();
      await database.client.end({ timeout: 0 });
      await host.dispose();
    } finally {
      owned?.restoreEnvironment();
    }
    throw cause;
  }
}

test.each(["retained-session", "absent-session"] as const)(
  "human Workspace bootstrap retry reaches the authenticated endpoint with %s",
  async (session) => {
    const f = await setup(2, session);
    try {
      await f.controller.reconcile(f.changeID);
      const identity = await f.identities();
      const commandID = crypto.randomUUID();
      expect(await f.nativeRetry(commandID)).toMatchObject({ ok: true });
      expect(await f.nativeRetry(commandID)).toMatchObject({ ok: true });
      expect(await f.row()).toMatchObject({ state: "runner-starting", runner: "17" });
      expect((await f.row()).runtime).not.toBe(f.bootstrapAttemptID);
      expect(f.counts()).toEqual({ registrations: 1, starts: 1, prompts: 0 });
      expect(await f.identities()).toEqual(identity);
      const [receipt] = await f.database.client<{ result: unknown }[]>`
        SELECT result FROM factory.execution_policy_command WHERE command_id=${commandID}`;
      expect(receipt?.result).toMatchObject({
        verificationID: f.verificationID,
        runtimeAttemptID: f.bootstrapAttemptID,
        actionRunID: "1",
        diagnosis: { kind: "execution-failed", jobs: [] },
      });
    } finally {
      await f.close();
    }
  },
);

test.each(["retained-session", "absent-session"] as const)(
  "human Workspace bootstrap retry is projected with %s",
  async (session) => {
    const f = await setup(0, session);
    try {
      await f.controller.reconcile(f.changeID);
      expect(await f.controller.get(f.changeID)).toMatchObject({
        verificationCommitSha: f.commit,
        checksRetryAttemptId: f.bootstrapAttemptID,
      });
    } finally {
      await f.close();
    }
  },
);

test("human Workspace checks resume requires the exact confirmed Stop without rebinding Coding", async () => {
  const f = await setup(2, "retained-session");
  try {
    await f.controller.reconcile(f.changeID);
    await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
      updated_at=clock_timestamp() WHERE change_id=${f.changeID}`;
    const identity = await f.identities();
    const commandID = crypto.randomUUID();
    expect(await f.nativeResume(commandID, crypto.randomUUID())).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await f.nativeResume(commandID)).toMatchObject({ ok: true });
    expect(await f.nativeResume(commandID)).toMatchObject({ ok: true });
    expect(await f.identities()).toEqual(identity);
    expect(await f.controller.get(f.changeID)).toMatchObject({
      checksStopId: null,
      checksRetryAttemptId: f.bootstrapAttemptID,
    });
    expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
  } finally {
    await f.close();
  }
});

test("human Workspace confirmed checks Stop is projected independently of the stopped Coding turn", async () => {
  const f = await setup(0, "retained-session");
  try {
    await f.controller.reconcile(f.changeID);
    await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
      updated_at=clock_timestamp() WHERE change_id=${f.changeID}`;
    expect(await f.controller.get(f.changeID)).toMatchObject({
      checksStopId: f.stopID,
      checksRetryAttemptId: null,
    });
  } finally {
    await f.close();
  }
});

test.each([
  "missing-receipt",
  "newer-writer-epoch",
  "human-writer",
  "handoff",
  "writer-fence",
  "dirty-buffer",
  "conflicted-buffer",
  "pending-stop",
  "unfinished-commit",
  "later-origin-same-sha",
] as const)("human Workspace retry and checks resume refuse %s", async (condition) => {
  const f = await setup(2, "retained-session");
  try {
    await f.controller.reconcile(f.changeID);
    if (condition === "missing-receipt")
      await f.database.client`DELETE FROM factory.workspace_submission WHERE id=${f.submittedID}`;
    if (condition === "newer-writer-epoch")
      await f.database.client`UPDATE factory.change_writer SET epoch=epoch+1
        WHERE change_id=${f.changeID}`;
    if (condition === "human-writer")
      await f.database.client`UPDATE factory.change_writer SET state='human',user_id=${f.userID}
        WHERE change_id=${f.changeID}`;
    if (condition === "handoff")
      await f.database.client`UPDATE factory.change_writer SET state='handoff',
        requested_by=${f.userID},request_id=${crypto.randomUUID()} WHERE change_id=${f.changeID}`;
    if (condition === "writer-fence")
      await f.database.client`UPDATE factory.change_writer SET fence_required=true,
        fence_attempt_id=${f.workspaceAttemptID} WHERE change_id=${f.changeID}`;
    if (condition === "dirty-buffer" || condition === "conflicted-buffer")
      await f.database.client`INSERT INTO factory.workspace_shared_document(
        workspace_id,path,y_state,disk_version,dirty,conflict)
        VALUES(${f.workspaceID},'src/owned.ts',decode('','hex'),'owned-saved-version',
          ${condition === "dirty-buffer"},${condition === "conflicted-buffer"})`;
    if (condition === "pending-stop")
      await f.database
        .client`UPDATE factory.change_agent_session SET state='stopped',stop_pending=true
        WHERE change_id=${f.changeID}`;
    if (condition === "unfinished-commit" || condition === "later-origin-same-sha")
      await f.database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
        observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
        SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,
          (SELECT max(sequence)+1 FROM factory.change_commit_operation WHERE change_id=${f.changeID}),
          branch_name,commit_sha,${f.commit},
          ${condition === "later-origin-same-sha" ? f.commit : null},
          'Owned later origin',${crypto.randomUUID()},
          ${condition === "later-origin-same-sha" ? "succeeded" : "commit-intended"}::factory.change_commit_state,
          created_by,CASE WHEN ${condition === "later-origin-same-sha"} THEN now() END
        FROM factory.change_commit_operation WHERE id=${f.submittedID}`;
    const before = await f.row();
    expect(await f.nativeRetry(crypto.randomUUID())).toMatchObject({ ok: false, status: 409 });
    expect(await f.controller.get(f.changeID)).toMatchObject({ checksRetryAttemptId: null });
    await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
      updated_at=clock_timestamp() WHERE change_id=${f.changeID}`;
    expect(await f.nativeResume(crypto.randomUUID())).toMatchObject({ ok: false, status: 409 });
    expect(await f.controller.get(f.changeID)).toMatchObject({
      checksStopId: null,
      checksRetryAttemptId: null,
    });
    expect(await f.row()).toEqual(before);
    expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
  } finally {
    await f.close();
  }
});

test.each(["failed", "stopped"] as const)(
  "human Workspace receipt cannot authorize checks after a newer %s unsubmitted Coding turn",
  async (state) => {
    const f = await setup(2, "retained-session");
    try {
      await f.controller.reconcile(f.changeID);
      // Retain the same settled writer epoch to prove the submission itself
      // does not authorize later unsubmitted Coding, even after its Stop settles.
      const newer = await f.database.client.begin(async (sql) => {
        const admitted = await f.turns.admitIn(
          sql,
          {
            kind: "change-prompt",
            commandId: crypto.randomUUID(),
            projectId: f.projectID,
            ticketId: f.ticketID,
            conversationId: f.initial.command.conversationId,
            changeId: f.changeID,
            createdBy: f.userID,
            text: "Later unsubmitted Coding",
          },
          f.initial.authority,
        );
        await sql`UPDATE factory.agent_turn SET state=${state}
          WHERE id=${admitted.turn.id} AND state='pending'`;
        await sql`UPDATE factory.change_agent_session SET active_turn_id=${admitted.turn.id},
          updated_at=clock_timestamp() WHERE change_id=${f.changeID}`;
        return admitted.turn.id;
      });
      const before = await f.row();
      expect(await f.nativeRetry(crypto.randomUUID())).toMatchObject({ ok: false, status: 409 });
      expect(await f.controller.get(f.changeID)).toMatchObject({ checksRetryAttemptId: null });
      const newerStopID = crypto.randomUUID();
      await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
        stop_id=${newerStopID},stop_turn_id=${newer},updated_at=clock_timestamp()
        WHERE change_id=${f.changeID}`;
      const identity = await f.identities();
      expect(await f.nativeResume(crypto.randomUUID(), newerStopID)).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(await f.controller.get(f.changeID)).toMatchObject({ checksStopId: null });
      expect(await f.identities()).toEqual(identity);
      expect(await f.row()).toEqual(before);
      expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
    } finally {
      await f.close();
    }
  },
);

test.each(["absent-session", "unknown-stop", "newer-stop"] as const)(
  "human Workspace checks resume cannot invent or replace %s authority",
  async (condition) => {
    const f = await setup(
      0,
      condition === "absent-session" ? "absent-session" : "retained-session",
    );
    try {
      await f.controller.reconcile(f.changeID);
      if (condition !== "absent-session")
        await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
          stop_id=${condition === "unknown-stop" ? null : crypto.randomUUID()},
          updated_at=clock_timestamp() WHERE change_id=${f.changeID}`;
      const identity = await f.identities();
      expect(await f.nativeResume(crypto.randomUUID())).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(await f.identities()).toEqual(identity);
      if (condition !== "newer-stop")
        expect(await f.controller.get(f.changeID)).toMatchObject({ checksStopId: null });
      expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
    } finally {
      await f.close();
    }
  },
);

test("a failed bootstrap is retained and cleaned up without silently starting another runner", async () => {
  const f = await setup();
  try {
    await f.controller.reconcile(f.changeID);
    await f.controller.reconcile(f.changeID);
    expect(await f.row()).toMatchObject({
      state: "failed",
      runtime: f.bootstrapAttemptID,
      runner: null,
      diagnosis: { kind: "execution-failed", runtimeAttemptId: f.bootstrapAttemptID, jobs: [] },
    });
    expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
    expect(f.stopped).toEqual([f.bootstrapAttemptID]);
    expect(f.removed).toEqual([16]);
    const [stopped] = await f.database.client`
      SELECT attempt.state,attempt.failure,binding.deleted_at IS NOT NULL AS deleted
      FROM factory.runtime_attempt attempt
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      WHERE attempt.id=${f.bootstrapAttemptID}`;
    expect(stopped).toEqual({
      state: "stopped",
      failure: "Dev Container postCreateCommand failed: owned browser download failed",
      deleted: true,
    });
    const [source] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(source?.state).toBe("ready");
    const [session] = await f.database.client<{ state: string; turn: string }[]>`
      SELECT state,active_turn_id AS turn FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
    expect(session).toMatchObject({ state: "committed", turn: f.initial.id });
  } finally {
    await f.close();
  }
});

test("completed Verification cannot hand off to review before original Actor deletion is confirmed", async () => {
  const f = await setup();
  try {
    await f.database.client`UPDATE factory.verification SET state='succeeded',
      completed_at=now(),runner_id=NULL WHERE id=${f.verificationID}`;
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped'
      WHERE id=${f.bootstrapAttemptID}`;
    await f.controller.reconcile(f.changeID);
    expect(f.reviews).toEqual([]);
    expect(
      await f.database.client`SELECT id FROM factory.candidate_review
      WHERE verification_id=${f.verificationID}`,
    ).toHaveLength(0);
    await f.jobs.stop(f.bootstrapAttemptID);
    await f.controller.reconcile(f.changeID);
    expect(f.reviews).toHaveLength(1);
    expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
  } finally {
    await f.close();
  }
});

test.each([0, 1, 2])(
  "an explicit native retry after %i integrations retains the failed outcome and never redispatches repeated commands",
  async (integrations) => {
    const f = await setup(integrations);
    try {
      await f.controller.reconcile(f.changeID);
      const failed = await f.row();
      expect(await f.controller.get(f.changeID)).toMatchObject({
        checksRetryAttemptId: f.bootstrapAttemptID,
      });
      const commandID = crypto.randomUUID();
      const call = () => f.nativeRetry(commandID);
      const responses = await Promise.all([call(), call()]);
      expect(responses).toMatchObject([{ ok: true }, { ok: true }]);
      const retried = await f.row();
      expect(retried).toMatchObject({ state: "runner-starting", runner: "17", diagnosis: null });
      expect(retried.runtime).not.toBe(f.bootstrapAttemptID);
      expect(f.counts()).toEqual({ registrations: 1, starts: 1, prompts: 0 });
      const [receipt] = await f.database.client<{ result: unknown }[]>`
      SELECT result FROM factory.execution_policy_command WHERE command_id=${commandID}`;
      expect(receipt?.result).toMatchObject({
        verificationID: f.verificationID,
        runtimeAttemptID: f.bootstrapAttemptID,
        state: "failed",
        diagnosis: failed.diagnosis,
      });
      const observations = f.observations();
      expect(await call()).toMatchObject({ ok: true });
      expect(f.observations()).toBe(observations);
      expect(f.counts()).toEqual({ registrations: 1, starts: 1, prompts: 0 });
      expect(await f.nativeRetry(commandID, crypto.randomUUID())).toMatchObject({
        ok: false,
        status: 409,
      });
      const [original] = await f.database.client<{ state: string; failure: string }[]>`
      SELECT state,failure FROM factory.runtime_attempt WHERE id=${f.bootstrapAttemptID}`;
      expect(original).toMatchObject({
        state: "stopped",
        failure: "Dev Container postCreateCommand failed: owned browser download failed",
      });
    } finally {
      await f.close();
    }
  },
);

test("confirmed Stop can resume an integrated submitted candidate without replaying Coding", async () => {
  const f = await setup(2);
  try {
    await f.controller.reconcile(f.changeID);
    const stopID = crypto.randomUUID();
    await f.database.client`UPDATE factory.change_agent_session SET state='stopped',
      stop_id=${stopID},stop_pending=false WHERE change_id=${f.changeID}`;
    expect(await f.controller.get(f.changeID)).toMatchObject({ checksStopId: stopID });
    const commandID = crypto.randomUUID();
    await f.controller.resumeChecks(f.changeID, f.userID, commandID, f.verificationID, stopID);
    await f.controller.resumeChecks(f.changeID, f.userID, commandID, f.verificationID, stopID);
    expect(await f.controller.get(f.changeID)).toMatchObject({
      checksRetryAttemptId: f.bootstrapAttemptID,
    });
    expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
    const [session] = await f.database.client<{ state: string; turn: string }[]>`
      SELECT state,active_turn_id AS turn FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
    expect(session).toEqual({ state: "committed", turn: f.initial.id });
  } finally {
    await f.close();
  }
});

test("periodic bootstrap continuation observes the same queued runtime without retrying execution", async () => {
  const f = await setup();
  try {
    await f.controller.reconcile(f.changeID);
    await f.nativeRetry(crypto.randomUUID());
    const retained = await f.row();
    expect(retained.runtime).not.toBe(f.bootstrapAttemptID);
    expect(f.continuations()).toBe(1);
    await f.controller.reconcile(f.changeID);
    await f.controller.reconcile(f.changeID);
    expect(await f.row()).toEqual(retained);
    expect(f.continuations()).toBe(3);
    expect(f.counts()).toEqual({ registrations: 1, starts: 1, prompts: 0 });
  } finally {
    await f.close();
  }
});

test.each(["stale-verification", "later-submission"] as const)(
  "integrated bootstrap recovery still refuses %s",
  async (condition) => {
    const f = await setup(2);
    try {
      await f.controller.reconcile(f.changeID);
      const later = "9".repeat(40);
      await f.database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
        observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
        SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,4,branch_name,${f.commit},
          ${later},${later},'Later submission',${crypto.randomUUID()},'succeeded',created_by,now()
        FROM factory.change_commit_operation WHERE id=${f.initial.id}`;
      if (condition === "stale-verification")
        await f.database.client`INSERT INTO factory.verification(
          id,change_id,commit_sha,pull_request_number,runner_name,created_by)
          VALUES(${crypto.randomUUID()},${f.changeID},${later},1,'owned-later-job',${f.userID})`;
      await expect(
        f.database.client`UPDATE factory.verification SET commit_sha=${later}
          WHERE id=${f.verificationID}`.execute(),
      ).rejects.toThrow("immutable");
      const before = await f.row();
      expect((await f.controller.get(f.changeID))?.["checksRetryAttemptId"]).toBeNull();
      await expect(
        f.controller.retryBootstrap(
          f.changeID,
          f.userID,
          crypto.randomUUID(),
          f.verificationID,
          f.bootstrapAttemptID,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await f.row()).toEqual(before);
      expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
    } finally {
      await f.close();
    }
  },
);

test.each([
  "cleanup",
  "revocation",
  "stale-runtime",
  "wrong-verification",
  "stop",
  "uncertain",
  "human-writer",
  "contributor",
  "changed-candidate",
  "unfinished-commit",
  "unsubmitted",
  "cancelled",
  "trashed",
  "executed-check",
  "unknown-execution",
  "open-thread",
] as const)(
  "bootstrap retry refuses %s without creating compute or changing the failure",
  async (condition) => {
    const f = await setup();
    try {
      if (condition === "cleanup") f.setCleanup(false);
      if (condition === "revocation") f.setRevocation(false);
      if (condition === "unknown-execution") f.setActionState("running");
      await f.controller.reconcile(f.changeID);
      if (condition === "stop") await createChangeAgentStop(f.database, f.hub).persist(f.changeID);
      if (condition === "uncertain") {
        const admitted = await createChangeAdmission(f.database, buildModelID).admit(
          f.changeID,
          f.userID,
          { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned uncertain work" },
        );
        const turn = await f.turns.claimPending(admitted.turn.id);
        if (!turn?.ownerToken) throw new Error("Owned uncertain work was not claimed");
        await f.writers.prepareAgent(f.changeID, turn.id);
        await f.turns.beginDispatch(turn.id, turn.ownerToken);
        await f.turns.settle(turn.id, turn.ownerToken, "uncertain", "Owned lost outcome");
      }
      if (condition === "human-writer")
        await f.database.client`UPDATE factory.change_writer SET state='human',turn_id=NULL,
        user_id=${f.userID},fence_required=false,fence_attempt_id=NULL WHERE change_id=${f.changeID}`;
      if (condition === "contributor")
        await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      if (["changed-candidate", "unfinished-commit"].includes(condition))
        await f.database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
        observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
        SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,2,branch_name,commit_sha,${"e".repeat(40)},
          ${condition === "changed-candidate" ? "e".repeat(40) : null},
          'Owned later candidate',${crypto.randomUUID()},
          ${condition === "changed-candidate" ? "succeeded" : "commit-intended"}::factory.change_commit_state,
          created_by,CASE WHEN ${condition === "changed-candidate"} THEN now() END
        FROM factory.change_commit_operation WHERE id=${f.initial.id}`;
      if (condition === "unsubmitted")
        await f.database
          .client`UPDATE factory.change_agent_session SET active_turn_id=NULL WHERE change_id=${f.changeID}`;
      if (condition === "cancelled")
        await f.database
          .client`UPDATE factory.change SET cancel_requested_at=now() WHERE id=${f.changeID}`;
      if (condition === "trashed")
        await f.database
          .client`UPDATE factory.ticket SET trashed_at=now(),trashed_by=${f.userID} WHERE id=${f.ticketID}`;
      if (condition === "executed-check")
        await f.database
          .client`UPDATE factory.verification SET diagnosis=jsonb_set(diagnosis,'{kind}','"check-failed"')
        WHERE id=${f.verificationID}`;
      if (condition === "open-thread")
        await f.database
          .client`INSERT INTO factory.review_feedback(id,change_id,author_id,kind,commit_sha)
        VALUES(${crypto.randomUUID()},${f.changeID},${f.userID},'thread',${f.commit})`;
      const before = await f.row();
      await expect(
        f.controller.retryBootstrap(
          f.changeID,
          f.userID,
          crypto.randomUUID(),
          condition === "wrong-verification" ? crypto.randomUUID() : f.verificationID,
          condition === "stale-runtime" ? crypto.randomUUID() : f.bootstrapAttemptID,
        ),
      ).rejects.toMatchObject({ code: condition === "contributor" ? "forbidden" : "conflict" });
      expect(await f.row()).toEqual(before);
      if (!["stale-runtime", "wrong-verification", "contributor"].includes(condition))
        expect((await f.controller.get(f.changeID))?.["checksRetryAttemptId"]).toBeNull();
      expect(f.counts()).toEqual({ registrations: 0, starts: 0, prompts: 0 });
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  "cancellation during an explicit bootstrap retry revokes a late runner, failed first revocation=%s",
  async (failedRevocation) => {
    const f = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retry: Promise<unknown> | undefined;
    try {
      await f.controller.reconcile(f.changeID);
      f.holdRegistration(async () => {
        entered.resolve();
        await release.promise;
      });
      retry = f.controller.retryBootstrap(
        f.changeID,
        f.userID,
        crypto.randomUUID(),
        f.verificationID,
        f.bootstrapAttemptID,
      );
      await entered.promise;
      f.setRevocation(!failedRevocation);
      await f.database
        .client`UPDATE factory.change SET state='cancelling',cancel_requested_at=now() WHERE id=${f.changeID}`;
      await f.controller.cancel(f.changeID);
      release.resolve();
      await retry;
      if (failedRevocation)
        expect(await f.row()).toMatchObject({ state: "cancelled", runner: "17" });
      f.setRevocation(true);
      await f.controller.reconcile(f.changeID);
      expect(await f.row()).toMatchObject({ state: "cancelled", runner: null, runtime: null });
      expect(f.counts()).toEqual({ registrations: 1, starts: 0, prompts: 0 });
      expect(f.removed).toEqual([16, 17]);
      const [source] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
      expect(source?.state).toBe("ready");
    } finally {
      release.resolve();
      await retry?.catch(() => undefined);
      await f.close();
    }
  },
);
