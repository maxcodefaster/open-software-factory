import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { observeFactoryboxNodes } from "../../packages/runtime-kubernetes/src/factorybox-node-discovery";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import {
  installOwnedRuntimeConfiguration,
  ownedFactoryboxProfile,
} from "../fixtures/runtime-configuration";

let restoreConfiguration: () => void;
beforeAll(() => {
  restoreConfiguration = installOwnedRuntimeConfiguration();
});
afterAll(() => restoreConfiguration());

async function submitted(remote = false) {
  const host = await factoryProcess();
  const owned = await fixture(undefined, undefined, host.connect());
  const coding = owned.controller();
  try {
    owned.acceptResponse();
    await coding.prompt(
      owned.changeID,
      "Owned handoff implementation",
      owned.userID,
      crypto.randomUUID(),
    );
    await owned.requested;
    owned.finish();
    owned.release();
    await eventually(
      async () => (await coding.get(owned.changeID, undefined, false)).state,
      (state) => state === "committed",
      "Owned implementation was not submitted",
    );
    await coding.shutdown();
    const verificationID = crypto.randomUUID();
    await owned.database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,runner_uuid,runner_token,
      action_run_id,runner_job_handle,created_by)
      VALUES(${verificationID},${owned.changeID},${"d".repeat(40)},1,'owned-handoff',
        ${crypto.randomUUID()},'owned-handoff-not-a-secret',1,'owned-handoff-job',${owned.userID})`;
    // Keep this controller proof offline. The assertion is before even admitting
    // a Verification Runtime, not a simulated successful Sysbox teardown.
    await owned.database
      .client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
      VALUES('factory',1,'{"sandboxes":0}'::jsonb,${owned.userID})`;
    const child = {
      data: { kind: "connector", role: "child", attemptID: owned.attemptID, generation: 1 },
      send: () => 1,
      close() {},
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    owned.hub.open(child);
    owned.hub.message(
      child,
      JSON.stringify({
        type: "hello",
        role: "child",
        terminalCount: 0,
        terminalBusy: 0,
        terminalRevision: 1,
      }),
    );
    const parent = {
      data: { kind: "connector", role: "parent", attemptID: owned.attemptID, generation: 1 },
      send: () => 1,
      close() {},
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    owned.hub.open(parent);
    let discoveries = 0;
    const runtime = createRuntimeController(
      owned.database,
      owned.hub,
      "owned-verification-handoff",
      {
        async prepareExecution() {
          throw new Error("Verification cannot prepare or replace Development Source");
        },
      },
      {
        ...createKubernetesClient(),
        async apply() {
          throw new Error("Owned queued proof cannot create native resources");
        },
      },
      async () => "",
      undefined,
      undefined,
      remote
        ? async () => {
            discoveries++;
            if (discoveries !== 1)
              throw new Error(
                "Retained Verification must not rediscover or adopt another destination",
              );
            return {
              candidates: [
                {
                  nodeName: "owned-node-b",
                  identity: {
                    uid: "owned-node-b-uid",
                    bootID: "owned-node-b-boot",
                    architecture: "amd64",
                    operatingSystem: "linux",
                  },
                  profile: {
                    ...ownedFactoryboxProfile,
                    nodeName: "owned-node-b",
                    resources: { cpuMilli: 3000, memoryMiB: 3072 },
                  },
                },
              ],
              refused: [],
            };
          }
        : observeFactoryboxNodes,
    );
    const stopped: string[] = [];
    const stop = spyOn(runtime, "stop").mockImplementation(async (id) => {
      const [intent] = await owned.database.client<{ state: string; intended: boolean }[]>`
        SELECT state,stop_intended_at IS NOT NULL AS intended FROM factory.runtime_attempt WHERE id=${id}`;
      expect(intent).toEqual({ state: "stop-intended", intended: true });
      stopped.push(id);
      return runtime.get(id);
    });
    const retained = async () => {
      const [row] = await owned.database.client`
        SELECT session.state,session.active_turn_id,session.opencode_session_id,
          writer.state AS writer_state,writer.epoch AS writer_epoch,
          writer.turn_id AS writer_turn,writer.user_id AS writer_user,
          workspace.id AS workspace,workspace.source_revision,
          (SELECT json_agg(to_jsonb(c) ORDER BY sequence) FROM factory.change_commit_operation c
            WHERE c.change_id=session.change_id) AS commits,
          (SELECT json_agg(to_jsonb(a) ORDER BY id) FROM factory.requirement_approval a
            WHERE a.ticket_id=workspace.ticket_id) AS approvals
        FROM factory.change_agent_session session
        JOIN factory.development_workspace workspace ON workspace.change_id=session.change_id
        JOIN factory.change_writer writer ON writer.change_id=session.change_id
        WHERE session.change_id=${owned.changeID}`;
      return row;
    };
    return {
      ...owned,
      verificationID,
      runtime,
      stopped,
      retained,
      stop,
      child,
      parent,
      discoveries: () => discoveries,
      async close() {
        stop.mockRestore();
        owned.hub.revoke(owned.attemptID);
        await owned.dispose();
        await host.dispose();
      },
    };
  } catch (error) {
    owned.release();
    await coding.shutdown();
    await owned.dispose();
    await host.dispose();
    throw error;
  }
}

// Controller-only evidence. Native two-node evidence must use real Kubernetes,
// Factorybox, Source and Forgejo and is recorded separately from this fixture.
test("fresh remote Verification retains destination before compute and never reclaims concurrent work or canonical Source on A", async () => {
  const f = await submitted(true);
  try {
    f.hub.message(
      f.child,
      JSON.stringify({
        type: "terminal-state",
        terminalRevision: 2,
        terminalCount: 1,
        terminalBusy: 1,
      }),
    );
    const before = await f.retained();
    const verification = await f.runtime.startVerification(f.verificationID, f.userID);
    if (!verification) throw new Error("Owned remote Verification intent is missing");
    expect(verification?.state).toBe("create-intended");
    expect(verification?.revision).toBe("d".repeat(40));
    const [binding] = await f.database.client<
      Array<{
        workerID: string;
        admissionID: string;
        namespace: string;
        workspaceID: string | null;
        profile: unknown;
      }>
    >`
      SELECT attempt.factorybox_worker_id AS "workerID",attempt.factorybox_admission_id AS "admissionID",
        attempt.kubernetes_namespace AS namespace,attempt.workspace_id AS "workspaceID",artifact.factorybox_profile AS profile
      FROM factory.runtime_attempt attempt JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
      WHERE attempt.id=${verification.id}`;
    expect(binding?.workspaceID).toBeNull();
    expect(binding?.profile).toMatchObject({
      nodeName: "owned-node-b",
      resources: { cpuMilli: 3000, memoryMiB: 3072 },
    });
    const [coding] = await f.database.client<
      Array<{ workerID: string; namespace: string; state: string }>
    >`
      SELECT factorybox_worker_id AS "workerID",kubernetes_namespace AS namespace,state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    if (!coding) throw new Error("Owned Coding runtime is missing");
    expect(coding?.state).toBe("ready");
    expect(binding?.workerID).not.toBe(coding?.workerID);
    expect(binding?.namespace).not.toBe(coding?.namespace);
    expect(f.stopped).toEqual([]);
    expect(await f.retained()).toEqual(before);
    expect((await f.runtime.startVerification(f.verificationID, f.userID))?.id).toBe(
      verification?.id,
    );
    expect(f.discoveries()).toBe(1);
    expect(f.stopped).toEqual([]);
    await expect(
      Promise.resolve(f.database
        .client`UPDATE factory.runtime_attempt SET factorybox_worker_id=${coding.workerID}
      WHERE id=${verification.id}`),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(f.database
        .client`UPDATE factory.verification_compute_placement SET worker_id=${coding.workerID}
      WHERE verification_id=${f.verificationID}`),
    ).rejects.toThrow("immutable");
    expect(f.requests()).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

test("fresh Verification waits for confirmed release of its submitted Coding runtime", async () => {
  const f = await submitted();
  const personal = crypto.randomUUID();
  const personalAttempt = crypto.randomUUID();
  try {
    await f.database.client`INSERT INTO factory.development_workspace(
      id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      VALUES(${personal},${f.projectID},'personal',${f.userID},'main',${"a".repeat(40)},${f.userID})`;
    await f.database.client`INSERT INTO factory.runtime_attempt(
      id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,
      child_connector_token_hash,create_intended_at,created_by)
      VALUES(${personalAttempt},${f.projectID},${personal},1,${"a".repeat(40)},'ready',
        ${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
    const before = await f.retained();
    expect(await f.runtime.startVerification(f.verificationID, f.userID)).toBeNull();
    expect(f.stopped).toEqual([f.attemptID]);
    expect(
      await f.database.client`SELECT id FROM factory.runtime_attempt
      WHERE verification_id=${f.verificationID}`,
    ).toHaveLength(0);
    expect(await f.runtime.startVerification(f.verificationID, f.userID)).toBeNull();
    expect(f.stopped).toEqual([f.attemptID]);
    await f.database.client`UPDATE factory.runtime_attempt SET state='cleanup-failed'
      WHERE id=${f.attemptID}`;
    expect(await f.runtime.startVerification(f.verificationID, f.userID)).toBeNull();
    expect(f.stopped).toEqual([f.attemptID]);
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now()
      WHERE id=${f.attemptID}`;
    const verification = await f.runtime.startVerification(f.verificationID, f.userID);
    expect(verification?.id).not.toBe(f.attemptID);
    expect(verification?.state).toBe("create-intended");
    expect(verification?.revision).toBe("d".repeat(40));
    expect(await f.retained()).toEqual(before);
    const [unrelated] = await f.database.client<{ state: string; intended: boolean }[]>`
      SELECT state,stop_intended_at IS NOT NULL AS intended FROM factory.runtime_attempt
      WHERE id=${personalAttempt}`;
    expect(unrelated).toEqual({ state: "ready", intended: false });
    expect(f.requests()).toBe(1);
  } finally {
    await f.database.client`DELETE FROM factory.runtime_attempt
      WHERE id=${personalAttempt} AND project_id=${f.projectID}
        AND kubernetes_uid IS NULL AND kubernetes_namespace_uid IS NULL`;
    await f.database.client`DELETE FROM factory.development_workspace
      WHERE id=${personal} AND project_id=${f.projectID} AND kind='personal' AND owner_user_id=${f.userID}`;
    await f.close();
  }
}, 30_000);

test.each(["terminal", "unknown terminal", "operation"] as const)(
  "Verification handoff waits for a live %s without stopping it",
  async (condition) => {
    const f = await submitted();
    let pending: Promise<unknown> | undefined;
    const operationID = crypto.randomUUID();
    try {
      if (condition === "operation") {
        pending = RuntimeHub.prototype.parentOperation
          .call(f.hub, f.attemptID, {
            operationId: operationID,
            action: "git-observe-checkout",
          })
          .catch(() => undefined);
      } else {
        f.hub.message(
          f.child,
          JSON.stringify({
            type: "terminal-state",
            terminalRevision: 2,
            ...(condition === "terminal" ? { terminalCount: 1, terminalBusy: 0 } : {}),
          }),
        );
      }
      const before = await f.retained();
      expect(await f.runtime.startVerification(f.verificationID, f.userID)).toBeNull();
      expect(f.stopped).toEqual([]);
      expect(
        await f.database.client`SELECT id FROM factory.runtime_attempt
        WHERE verification_id=${f.verificationID}`,
      ).toHaveLength(0);
      if (condition === "operation") {
        f.hub.message(
          f.parent,
          JSON.stringify({
            type: "operation-response",
            operationId: operationID,
            action: "git-observe-checkout",
            error: "Owned observation ended without mutation",
          }),
        );
        await pending;
      } else {
        f.hub.message(
          f.child,
          JSON.stringify({
            type: "terminal-state",
            terminalRevision: 3,
            terminalCount: 0,
            terminalBusy: 0,
          }),
        );
      }
      expect(await f.runtime.startVerification(f.verificationID, f.userID)).toBeNull();
      expect(f.stopped).toEqual([f.attemptID]);
      expect(await f.retained()).toEqual(before);
    } finally {
      f.hub.revoke(f.attemptID);
      await pending;
      await f.close();
    }
  },
  30_000,
);

test("lost handoff Stop output keeps its exact intent without replaying or admitting Verification", async () => {
  const f = await submitted();
  try {
    f.stop.mockImplementation(async (id) => {
      f.stopped.push(id);
      throw new Error("Owned Stop output was lost");
    });
    const before = await f.retained();
    await expect(f.runtime.startVerification(f.verificationID, f.userID)).rejects.toThrow(
      "Owned Stop output was lost",
    );
    expect(await f.runtime.startVerification(f.verificationID, f.userID)).toBeNull();
    expect(f.stopped).toEqual([f.attemptID]);
    expect(
      await f.database.client`SELECT id FROM factory.runtime_attempt
      WHERE verification_id=${f.verificationID}`,
    ).toHaveLength(0);
    expect(await f.retained()).toEqual(before);
  } finally {
    await f.close();
  }
}, 30_000);

test("rolled-back handoff intent releases its observation fence without stopping compute", async () => {
  const f = await submitted();
  const release = spyOn(f.hub, "releaseIdle");
  try {
    await f.database.client.unsafe(`
      CREATE FUNCTION factory.owned_handoff_rollback() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN
        IF NEW.state='stop-intended' THEN RAISE EXCEPTION 'Owned handoff rollback'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER owned_handoff_rollback BEFORE UPDATE OF state ON factory.runtime_attempt
      FOR EACH ROW EXECUTE FUNCTION factory.owned_handoff_rollback();
    `);
    const before = await f.retained();
    await expect(f.runtime.startVerification(f.verificationID, f.userID)).rejects.toThrow(
      "Owned handoff rollback",
    );
    expect(f.stopped).toEqual([]);
    expect(release).toHaveBeenCalledWith(f.attemptID);
    const [unchanged] = await f.database.client<{ state: string; intended: boolean }[]>`
      SELECT state,stop_intended_at IS NOT NULL AS intended FROM factory.runtime_attempt
      WHERE id=${f.attemptID}`;
    expect(unchanged).toEqual({ state: "ready", intended: false });
    expect(await f.retained()).toEqual(before);
    await f.database.client.unsafe(
      "DROP TRIGGER owned_handoff_rollback ON factory.runtime_attempt",
    );
    expect(await f.runtime.startVerification(f.verificationID, f.userID)).toBeNull();
    expect(f.stopped).toEqual([f.attemptID]);
  } finally {
    release.mockRestore();
    await f.close();
  }
}, 30_000);

test.each([
  "human",
  "unsubmitted",
  "unfinished commit",
  "pending turn",
  "uncertain turn",
  "other runtime",
  "older candidate",
] as const)(
  "Verification never reclaims %s as settled submitted Agent execution",
  async (condition) => {
    const f = await submitted();
    const claims = spyOn(f.hub, "claimIdle");
    let verificationID = f.verificationID;
    let currentAttempt = f.attemptID;
    try {
      if (condition === "human")
        await f.database.client`UPDATE factory.change_writer SET state='human',turn_id=NULL,
          user_id=${f.userID},fence_required=false WHERE change_id=${f.changeID}`;
      if (condition === "unsubmitted")
        await f.database.client`UPDATE factory.change_agent_session SET active_turn_id=NULL
          WHERE change_id=${f.changeID}`;
      if (condition === "unfinished commit")
        await f.database.client`INSERT INTO factory.change_commit_operation(
          id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
          commit_message,idempotency_key,state,created_by)
          SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,2,branch_name,commit_sha,
            'Owned unfinished commit',${crypto.randomUUID()},'commit-intended',${f.userID}
          FROM factory.change_commit_operation WHERE change_id=${f.changeID} AND sequence=1`;
      if (condition === "pending turn" || condition === "uncertain turn") {
        const [context] = await f.database.client<{ id: string | null }[]>`
          SELECT active_coding_context_id AS id FROM factory.ticket_conversation
          WHERE ticket_id=${f.ticketID}`;
        const next = await createChangeAdmission(f.database, buildModelID).admit(
          f.changeID,
          f.userID,
          {
            kind: "change-prompt",
            commandId: crypto.randomUUID(),
            text: "Owned unfinished work",
            ...(context?.id ? { contextId: context.id } : {}),
          },
        );
        if (condition === "uncertain turn") {
          const turns = createAgentTurnStore(f.database);
          const turn = await turns.claimPending(next.turn.id);
          if (!turn?.ownerToken) throw new Error("Owned uncertain lease missing");
          await f.writers.prepareAgent(f.changeID, turn.id);
          await turns.beginDispatch(turn.id, turn.ownerToken);
          await turns.settle(turn.id, turn.ownerToken, "uncertain", "Owned unconfirmed input");
        }
      }
      if (condition === "other runtime") {
        currentAttempt = crypto.randomUUID();
        await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now()
          WHERE id=${f.attemptID}`;
        await f.database.client`INSERT INTO factory.runtime_attempt(
          id,project_id,change_id,workspace_id,generation,revision,state,
          parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          SELECT ${currentAttempt},project_id,change_id,workspace_id,generation+1,${"d".repeat(40)},
            'ready',parent_connector_token_hash,child_connector_token_hash,now(),created_by
          FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
        await f.database.client`UPDATE factory.change SET runtime_attempt_id=${currentAttempt}
          WHERE id=${f.changeID}`;
      }
      if (condition === "older candidate") {
        await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
          WHERE id=${f.verificationID}`;
        verificationID = crypto.randomUUID();
        await f.database.client`INSERT INTO factory.verification(
          id,change_id,commit_sha,pull_request_number,runner_name,runner_uuid,runner_token,
          action_run_id,runner_job_handle,created_by)
          VALUES(${verificationID},${f.changeID},${"a".repeat(40)},1,'owned-earlier-candidate',
            ${crypto.randomUUID()},'owned-earlier-not-a-secret',2,'owned-earlier-job',${f.userID})`;
      }
      const before = await f.retained();
      await f.runtime.startVerification(verificationID, f.userID);
      expect(f.stopped).toEqual([]);
      expect(claims).not.toHaveBeenCalled();
      const [current] = await f.database.client<{ state: string; intended: boolean }[]>`
        SELECT state,stop_intended_at IS NOT NULL AS intended FROM factory.runtime_attempt
        WHERE id=${currentAttempt}`;
      expect(current).toEqual({ state: "ready", intended: false });
      expect(await f.retained()).toEqual(before);
      expect(f.requests()).toBe(1);
    } finally {
      claims.mockRestore();
      await f.close();
    }
  },
  30_000,
);

test("a completed integration releases its own execution without replacing the retained Coding Session", async () => {
  const f = await submitted();
  const integrationRuntime = crypto.randomUUID();
  const verificationID = crypto.randomUUID();
  const commit = "e".repeat(40);
  try {
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now()
      WHERE id=${f.attemptID}`;
    await f.database.client`INSERT INTO factory.runtime_attempt(
      id,project_id,change_id,workspace_id,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${integrationRuntime},project_id,change_id,workspace_id,generation+1,${"d".repeat(40)},
        'ready',parent_connector_token_hash,child_connector_token_hash,now(),created_by
      FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    await f.database.client`UPDATE factory.change SET runtime_attempt_id=${integrationRuntime}
      WHERE id=${f.changeID}`;
    await f.database.client`INSERT INTO factory.change_commit_operation(
      id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,merge_parent_sha,
      commit_sha,observed_remote_sha,commit_message,idempotency_key,state,source,created_by,completed_at)
      SELECT ${crypto.randomUUID()},change_id,${integrationRuntime},2,branch_name,commit_sha,
        ${"a".repeat(40)},${commit},${commit},'Owned clean integration',${crypto.randomUUID()},
        'succeeded','integration',${f.userID},now()
      FROM factory.change_commit_operation WHERE change_id=${f.changeID} AND sequence=1`;
    await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
      WHERE id=${f.verificationID}`;
    await f.database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,runner_uuid,runner_token,
      action_run_id,runner_job_handle,created_by)
      VALUES(${verificationID},${f.changeID},${commit},1,'owned-integration-handoff',
        ${crypto.randomUUID()},'owned-integration-not-a-secret',2,'owned-integration-job',${f.userID})`;
    const child = {
      data: { kind: "connector", role: "child", attemptID: integrationRuntime, generation: 2 },
      send: () => 1,
      close() {},
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    f.hub.open(child);
    f.hub.message(
      child,
      JSON.stringify({
        type: "hello",
        role: "child",
        terminalCount: 0,
        terminalBusy: 0,
        terminalRevision: 1,
      }),
    );
    const before = await f.retained();
    expect(await f.runtime.startVerification(verificationID, f.userID)).toBeNull();
    expect(f.stopped).toEqual([integrationRuntime]);
    expect(await f.retained()).toEqual(before);
  } finally {
    f.hub.revoke(integrationRuntime);
    await f.close();
  }
}, 30_000);

test("a concurrent retained Verification admission is observed without releasing another runtime", async () => {
  const f = await submitted();
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const retainedAttempt = crypto.randomUUID();
  let starting: ReturnType<typeof f.runtime.startVerification> | undefined;
  const owner = f.database.client.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${f.projectID}`}))`;
    locked.resolve();
    await release.promise;
    await sql`INSERT INTO factory.runtime_attempt(
      id,project_id,verification_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${retainedAttempt},${f.projectID},${f.verificationID},'verification',1,
        ${"d".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
    await sql`UPDATE factory.verification SET runtime_attempt_id=${retainedAttempt},state='running'
      WHERE id=${f.verificationID}`;
  });
  try {
    const before = await f.retained();
    await locked.promise;
    starting = f.runtime.startVerification(f.verificationID, f.userID);
    await eventually(
      async () => {
        const [row] = await f.database.client<{ blocked: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%') AS blocked`;
        return row?.blocked;
      },
      (blocked) => blocked === true,
      "Verification did not wait for the real admission lock",
    );
    release.resolve();
    await owner;
    expect((await starting)?.id).toBe(retainedAttempt);
    expect(f.stopped).toEqual([]);
    expect(await f.retained()).toEqual(before);
  } finally {
    release.resolve();
    await owner;
    await starting;
    await f.close();
  }
}, 30_000);

test("continuing a queued Verification releases submitted Coding but retains the original verifier", async () => {
  const f = await submitted();
  const verifier = crypto.randomUUID();
  try {
    await f.database.client`INSERT INTO factory.runtime_attempt(
      id,project_id,verification_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${verifier},${f.projectID},${f.verificationID},'verification',1,
        ${"d".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
    await f.database.client`UPDATE factory.verification SET runtime_attempt_id=${verifier},
      state='runner-starting' WHERE id=${f.verificationID}`;
    const before = await f.retained();
    expect((await f.runtime.startVerification(f.verificationID, f.userID))?.id).toBe(verifier);
    expect(f.stopped).toEqual([f.attemptID]);
    expect((await f.runtime.startVerification(f.verificationID, f.userID))?.id).toBe(verifier);
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now()
      WHERE id=${f.attemptID}`;
    expect((await f.runtime.startVerification(f.verificationID, f.userID))?.id).toBe(verifier);
    expect(f.stopped).toEqual([f.attemptID]);
    expect(
      (
        await f.database.client<{ id: string }[]>`SELECT id FROM factory.runtime_attempt
          WHERE verification_id=${f.verificationID}`
      ).map((row) => row.id),
    ).toEqual([verifier]);
    expect(await f.retained()).toEqual(before);
    expect(f.requests()).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

test.each(["failed", "stopped", "cleanup-failed"] as const)(
  "continuing a %s Verification runtime cannot create another execution",
  async (state) => {
    const f = await submitted();
    const verifier = crypto.randomUUID();
    try {
      await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now()
        WHERE id=${f.attemptID}`;
      await f.database.client`INSERT INTO factory.runtime_attempt(
        id,project_id,verification_id,isolated_kind,generation,revision,state,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${verifier},${f.projectID},${f.verificationID},'verification',1,
          ${"d".repeat(40)},${state}::factory.runtime_attempt_state,
          ${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
      await f.database.client`UPDATE factory.verification SET runtime_attempt_id=${verifier},
        state='runner-starting' WHERE id=${f.verificationID}`;
      const before = await f.retained();
      for (let observation = 0; observation < 2; observation++)
        expect(await f.runtime.startVerification(f.verificationID, f.userID)).toMatchObject({
          id: verifier,
          state,
        });
      expect(f.stopped).toEqual([]);
      expect(
        (
          await f.database.client<{ id: string }[]>`SELECT id FROM factory.runtime_attempt
            WHERE verification_id=${f.verificationID}`
        ).map((row) => row.id),
      ).toEqual([verifier]);
      expect(await f.retained()).toEqual(before);
      expect(f.requests()).toBe(1);
    } finally {
      await f.close();
    }
  },
  30_000,
);
