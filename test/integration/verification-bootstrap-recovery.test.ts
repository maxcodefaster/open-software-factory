import { expect, test } from "bun:test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { createDeliveryService } from "../../apps/factory/src/delivery/service";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import {
  compiledFactoryEndpoint,
  decodeFactoryResponse,
  factoryFunctionRequest,
} from "../fixtures/server-functions";

async function setup() {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const f = await candidateReviewFixture(undefined, database);
    const attemptID = crypto.randomUUID();
    await database.client`DELETE FROM factory.candidate_review WHERE id=${f.reviewID}`;
    await database.client`UPDATE factory.verification SET state='runner-starting',
      summary=NULL,completed_at=NULL,runner_id=16,runner_uuid=${crypto.randomUUID()},
      runner_token='owned-bootstrap-token' WHERE id=${f.verificationID}`;
    await database.client`INSERT INTO factory.runtime_attempt(
      id,project_id,verification_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,failure)
      VALUES(${attemptID},${f.projectID},${f.verificationID},'verification',2,${f.commit},
        'failed',${"a".repeat(64)},${"b".repeat(64)},now(),${f.userID},
        'Dev Container postCreateCommand failed: owned browser download failed')`;
    await database.client`UPDATE factory.verification SET runtime_attempt_id=${attemptID}
      WHERE id=${f.verificationID}`;
    await database.client`INSERT INTO factory.pull_request_operation(
      id,change_id,repository_owner,repository_name,base_branch,head_branch,first_head_sha,
      title,body,idempotency_key,state,pull_request_number,pull_request_url,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','review','main',branch_name,${f.commit},
        'Owned bootstrap recovery','','owned-'||id,'succeeded',1,
        'https://forge.invalid/owned/review/pulls/1',now()
      FROM factory.change WHERE id=${f.changeID}`;
    let registrations = 0;
    let starts = 0;
    let prompts = 0;
    let observations = 0;
    let cleanup = true;
    let revoke = true;
    let actionState = "waiting";
    let registrationGate: (() => Promise<void>) | undefined;
    const stopped: string[] = [];
    const removed: number[] = [];
    const forge = {
      ...createForgejoClient({ apiURL: "http://127.0.0.1:9/api/v1/", token: "owned-unused" }),
      getPullRequest: async () => ({
        number: 1,
        headSha: f.commit,
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
            commitSha: f.commit,
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
          starts++;
          const nextID = crypto.randomUUID();
          await database.client`INSERT INTO factory.runtime_attempt(
            id,project_id,verification_id,isolated_kind,generation,revision,state,
            parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
            VALUES(${nextID},${f.projectID},${f.verificationID},'verification',3,${f.commit},
              'starting',${"c".repeat(64)},${"d".repeat(64)},now(),${f.userID})`;
          await database.client`UPDATE factory.verification SET runtime_attempt_id=${nextID}
            WHERE id=${f.verificationID}`;
          return null;
        },
        startStagingReplacement: async () => null,
        stop: async (id) => {
          stopped.push(id);
          if (cleanup)
            await database.client`UPDATE factory.runtime_attempt SET state='stopped',
              stop_intended_at=now(),stopped_at=now() WHERE id=${id}`;
          else
            await database.client`UPDATE factory.runtime_attempt SET state='cleanup-failed',
              stop_intended_at=now() WHERE id=${id}`;
          return null;
        },
      },
      {
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
      host,
      controller,
      bootstrapAttemptID: attemptID,
      stopped,
      removed,
      counts: () => ({ registrations, starts, prompts }),
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
        await controller.close();
        await database.client.end({ timeout: 0 });
        await host.dispose();
      },
    };
  } catch (cause) {
    await database.client.end({ timeout: 0 });
    await host.dispose();
    throw cause;
  }
}

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

test("an explicit native retry retains the failed outcome and repeated commands do not dispatch again", async () => {
  const f = await setup();
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
});

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
