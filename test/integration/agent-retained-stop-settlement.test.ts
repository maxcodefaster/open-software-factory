import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createRetainedStopSettlement } from "../../apps/factory/src/agent/retained-stop";
import { createChangeAgentStop, type RetainedStopTarget } from "../../apps/factory/src/agent/stop";
import type {
  RetainedStopClient,
  RetainedStopPod,
} from "../../packages/runtime-kubernetes/src/retained-stop";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

async function setup() {
  const owned = await fixture();
  owned.hub.connected = () => false;
  const namespaceUID = crypto.randomUUID(),
    claimUID = crypto.randomUUID(),
    sourcePodUID = crypto.randomUUID();
  await owned.database.client`UPDATE factory.factorybox_worker SET
    namespace_uid=${namespaceUID},source_claim_uid=${claimUID},node_name='owned-node'`;
  await owned.database.client`INSERT INTO factory.workspace_source
    (workspace_id,state,files_image,capability_hash,namespace_uid,claim_uid,pod_uid,storage_node)
    VALUES(${owned.workspaceID},'ready',${`owned/source@sha256:${"a".repeat(64)}`},
      ${"b".repeat(64)},${namespaceUID},${claimUID},${sourcePodUID},'owned-node')`;
  await owned.database.client`UPDATE factory.runtime_attempt SET state='create-intended'
    WHERE id=${owned.attemptID}`;
  await owned.database.client`INSERT INTO factory.runtime_artifact_intent
    (runtime_attempt_id,role,runtime_host_image,browser_tools_image)
    VALUES(${owned.attemptID},'build',${`owned/runtime@sha256:${"c".repeat(64)}`},
      ${`owned/browser@sha256:${"d".repeat(64)}`})`;
  await owned.database.client`UPDATE factory.runtime_attempt SET state='ready'
    WHERE id=${owned.attemptID}`;
  const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
    owned.changeID,
    owned.userID,
    { kind: "change-repair", commandId: crypto.randomUUID(), text: "Owned retained repair" },
  );
  await owned.database.client`UPDATE factory.change_agent_turn_intent
    SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${admitted.turn.id}`;
  await owned.database.client`UPDATE factory.change_agent_session SET
    state='starting',active_turn_id=${admitted.turn.id} WHERE change_id=${owned.changeID}`;
  await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
  await owned.database
    .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
  const [session] = await owned.database.client<{ stopID: string }[]>`
    SELECT stop_id AS "stopID" FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
  if (!session) throw new Error("Owned retained Stop is missing");
  const target: RetainedStopTarget = {
    changeID: owned.changeID,
    stopID: session.stopID,
    attemptID: owned.attemptID,
    sessionID: owned.sessionID,
    promptID: `msg_factory_${admitted.turn.id.replaceAll("-", "")}`,
    mode: "interrupt",
  };
  const pods = new Map<string, RetainedStopPod>();
  const calls: string[] = [];
  let loseCreate = false,
    loseCleanup = false,
    vanishCreate = false,
    nativeExited = true,
    failNative = false,
    terminal: RetainedStopPod["terminal"] = "not-started";
  const client: RetainedStopClient = {
    async observe(input) {
      calls.push("observe");
      return pods.get(input.recoveryID ?? input.stopID) ?? null;
    },
    async create(input) {
      const scope = input.recoveryID
        ? `retained-native-stop:${owned.changeID}:${input.recoveryID}`
        : `retained-native-stop:${owned.changeID}`;
      expect(
        await owned.database.client`SELECT command_id FROM factory.execution_policy_command
        WHERE actor_id=${owned.userID} AND scope IN (${`${scope}:intent`},${`${scope}:attempt`})`,
      ).toHaveLength(2);
      calls.push("create");
      const key = input.recoveryID ?? input.stopID;
      const pod: RetainedStopPod = {
        uid: crypto.randomUUID(),
        phase: failNative ? "Failed" : "Succeeded",
        ...(failNative
          ? terminal
            ? { terminal }
            : {}
          : { result: { ...input.input, confirmed: true, nativeProcessExited: true } }),
      };
      pods.set(key, pod);
      if (vanishCreate) pods.delete(key);
      if (loseCreate) throw new Error("Owned lost create response");
      if (!pods.has(key)) throw new Error("Owned missing create");
      return pod;
    },
    async remove(input, uid) {
      const key = input.recoveryID ?? input.stopID;
      const pod = pods.get(key);
      if (pod && pod.uid !== uid) throw new Error("Owned mismatched cleanup");
      if (pod) calls.push("delete");
      pods.delete(key);
      if (loseCleanup) throw new Error("Owned lost cleanup response");
    },
  };
  const settleWithImage = (image = `owned/native@sha256:${"e".repeat(64)}`) =>
    createRetainedStopSettlement(
      owned.database,
      {
        stop: async () => {
          calls.push("stop-exited-compute");
          await owned.database
            .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
          return null;
        },
      },
      owned.hub,
      client,
      { hasExited: async () => nativeExited },
      async () => "owned native Stop program",
      image,
    );
  const settle = settleWithImage();
  return {
    owned,
    target,
    settle,
    calls,
    settleWithImage,
    setNativeFailure(value: boolean, proof: RetainedStopPod["terminal"] | null = "not-started") {
      failNative = value;
      terminal = proof ?? undefined;
    },
    setLoseCreate(value: boolean) {
      loseCreate = value;
    },
    setVanishCreate(value: boolean) {
      vanishCreate = value;
    },
    setLoseCleanup(value: boolean) {
      loseCleanup = value;
    },
    setNativeExited(value: boolean) {
      nativeExited = value;
    },
    async records() {
      return owned.database.client`SELECT scope,input,result FROM factory.execution_policy_command
        WHERE actor_id=${owned.userID} AND scope LIKE ${`retained-native-stop:${owned.changeID}:%`}`;
    },
    async dispose() {
      await owned.database.client`DELETE FROM factory.execution_policy_command
        WHERE actor_id=${owned.userID} AND scope LIKE ${`retained-native-stop:${owned.changeID}:%`}`;
      await owned.database
        .client`DELETE FROM factory.workspace_source WHERE workspace_id=${owned.workspaceID}`;
      await owned.dispose();
    },
  };
}

test("native Stop settlement persists intent before one create and retains its exact outcome", async () => {
  const owned = await setup();
  try {
    const stop = createChangeAgentStop(owned.owned.database, owned.owned.hub, owned.settle);
    expect(await stop.confirm(owned.target.changeID)).toBe(true);
    expect(owned.calls).toEqual(["observe", "create", "delete"]);
    expect(await owned.records()).toHaveLength(5);
    expect(owned.owned.requests()).toBe(0);
    expect(owned.owned.interrupts()).toBe(0);
    const [session] = await owned.owned.database.client`
      SELECT stop_pending,runtime_attempt_id,opencode_session_id FROM factory.change_agent_session
      WHERE change_id=${owned.target.changeID}`;
    expect(session).toEqual({
      stop_pending: false,
      runtime_attempt_id: owned.target.attemptID,
      opencode_session_id: owned.target.sessionID,
    });
  } finally {
    await owned.dispose();
  }
});

test("a read-only Stop check cannot commission native settlement", async () => {
  const owned = await setup();
  try {
    expect(await owned.settle({ ...owned.target, mode: "observe" })).toBe(false);
    expect(owned.calls).toEqual([]);
    expect(await owned.records()).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("failed exited compute is settled before native Stop recovery without replacing its generation", async () => {
  const owned = await setup();
  try {
    await owned.owned.database.client`UPDATE factory.runtime_attempt SET state='cleanup-failed'
      WHERE id=${owned.target.attemptID}`;
    const stop = createChangeAgentStop(owned.owned.database, owned.owned.hub, owned.settle);
    expect(await stop.confirm(owned.target.changeID)).toBe(true);
    expect(owned.calls).toEqual(["stop-exited-compute", "observe", "create", "delete"]);
    expect(
      await owned.owned.database.client`SELECT id FROM factory.runtime_attempt
      WHERE workspace_id=${owned.owned.workspaceID}`,
    ).toHaveLength(1);
    expect(owned.owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("native Stop settlement requires positive original compute exit", async () => {
  const owned = await setup();
  try {
    owned.setNativeExited(false);
    expect(await owned.settle(owned.target)).toBe(false);
    expect(owned.calls).toEqual([]);
    expect(await owned.records()).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("lost native create response observes the same Pod without another create", async () => {
  const owned = await setup();
  try {
    owned.setLoseCreate(true);
    await expect(owned.settle(owned.target)).rejects.toThrow("Owned lost create");
    expect(await owned.records()).toHaveLength(2);
    expect(await owned.settle(owned.target)).toBe(true);
    expect(owned.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(owned.calls.filter((call) => call === "delete")).toHaveLength(1);
    const reads = owned.calls.length;
    expect(await owned.settle({ ...owned.target, mode: "observe" })).toBe(true);
    expect(owned.calls).toHaveLength(reads);
  } finally {
    await owned.dispose();
  }
});

test("an absent Pod after an uncertain native create never authorizes replacement", async () => {
  const owned = await setup();
  try {
    owned.setLoseCreate(true);
    owned.setVanishCreate(true);
    await expect(owned.settle(owned.target)).rejects.toThrow("Owned lost create");
    await expect(owned.settle(owned.target)).rejects.toThrow("create outcome is unconfirmed");
    expect(owned.calls.filter((call) => call === "create")).toHaveLength(1);
  } finally {
    await owned.dispose();
  }
});

test("lost native cleanup response retains proof and never repeats native execution", async () => {
  const owned = await setup();
  try {
    owned.setLoseCleanup(true);
    await expect(owned.settle(owned.target)).rejects.toThrow("Owned lost cleanup");
    expect(await owned.records()).toHaveLength(4);
    owned.setLoseCleanup(false);
    expect(await owned.settle(owned.target)).toBe(true);
    expect(owned.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(owned.calls.filter((call) => call === "delete")).toHaveLength(1);
    expect(await owned.records()).toHaveLength(5);
  } finally {
    await owned.dispose();
  }
});

test("changed Source observation cannot retarget a saved native Stop operation", async () => {
  const owned = await setup();
  try {
    owned.setLoseCreate(true);
    await expect(owned.settle(owned.target)).rejects.toThrow("Owned lost create");
    await owned.owned.database.client`UPDATE factory.workspace_source SET state='stopped'
      WHERE workspace_id=${owned.owned.workspaceID}`;
    await owned.owned.database.client`UPDATE factory.workspace_source SET
      access_epoch=access_epoch+1,state='create-intended',pod_uid=NULL
      WHERE workspace_id=${owned.owned.workspaceID}`;
    await owned.owned.database.client`UPDATE factory.workspace_source SET
      state='ready',pod_uid=${crypto.randomUUID()} WHERE workspace_id=${owned.owned.workspaceID}`;
    await expect(owned.settle(owned.target)).rejects.toThrow("Source or native artifact changed");
    expect(owned.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(owned.calls.filter((call) => call === "delete")).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("a new published tools image gets a distinct recovery only after exact terminal proof", async () => {
  const owned = await setup();
  try {
    owned.setNativeFailure(true);
    await expect(owned.settle(owned.target)).rejects.toThrow("no replacement was started");
    owned.setNativeFailure(false);
    const updated = owned.settleWithImage(`owned/native@sha256:${"f".repeat(64)}`);
    const stop = createChangeAgentStop(owned.owned.database, owned.owned.hub, updated);
    expect(await stop.confirm(owned.target.changeID)).toBe(true);
    const records = await owned.records();
    const intents = records.filter((row) => String(row["scope"]).endsWith(":intent"));
    expect(intents).toHaveLength(2);
    expect(owned.calls.filter((call) => call === "create")).toHaveLength(2);
    expect(owned.calls.filter((call) => call === "delete")).toHaveLength(2);
    expect(
      await owned.owned.database.client`SELECT id FROM factory.runtime_attempt
      WHERE workspace_id=${owned.owned.workspaceID}`,
    ).toHaveLength(1);
    expect(owned.owned.requests()).toBe(0);
    const [session] = await owned.owned.database.client<{ stopID: string; pending: boolean }[]>`
      SELECT stop_id AS "stopID",stop_pending AS pending FROM factory.change_agent_session
      WHERE change_id=${owned.target.changeID}`;
    expect(session).toEqual({ stopID: owned.target.stopID, pending: false });
  } finally {
    await owned.dispose();
  }
});

test("changing tools cannot replace a missing Pod with an unknown create outcome", async () => {
  const owned = await setup();
  try {
    owned.setLoseCreate(true);
    owned.setVanishCreate(true);
    await expect(owned.settle(owned.target)).rejects.toThrow("Owned lost create");
    const updated = owned.settleWithImage(`owned/native@sha256:${"f".repeat(64)}`);
    await expect(updated(owned.target)).rejects.toThrow("create outcome is unconfirmed");
    expect(owned.calls.filter((call) => call === "create")).toHaveLength(1);
  } finally {
    await owned.dispose();
  }
});

test("failed Pod status without native exit proof cannot authorize a successor", async () => {
  const owned = await setup();
  try {
    owned.setNativeFailure(true, null);
    await expect(owned.settle(owned.target)).rejects.toThrow("no replacement was started");
    const updated = owned.settleWithImage(`owned/native@sha256:${"f".repeat(64)}`);
    await expect(updated(owned.target)).rejects.toThrow("no replacement was started");
    expect(owned.calls.filter((call) => call === "create")).toHaveLength(1);
  } finally {
    await owned.dispose();
  }
});
