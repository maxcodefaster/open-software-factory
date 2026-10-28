import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { admitComputeIn, computeAllocationIn } from "../../apps/factory/src/usage/compute";
import { createComputeWait } from "../../apps/factory/src/usage/compute-wait";
import { defaultExecutionPolicy } from "../../packages/conversation-domain/src/execution-policy";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import { fixture } from "../fixtures/change-agent-turns";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { factoryProcess } from "../fixtures/factory-process";
import { ownedFactoryboxProfile } from "../fixtures/runtime-configuration";

test("an explicitly admitted new Agent turn can create compute after confirmed Stop without reviving stopped work", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const work = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${work.attemptID}`;
    await database.client`UPDATE factory.change_agent_session SET state='stopped',stop_pending=false WHERE change_id=${work.changeID}`;
    const admission = createChangeAdmission(database, "factory-coding-model");
    const next = await admission.admit(work.changeID, work.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    await work.writers.prepareAgent(work.changeID, next.turn.id);
    const waits = createComputeWait(database);
    let creates = 0;
    const create = async () => {
      creates++;
      return true;
    };
    expect(await waits.launch(work.attemptID, create)).toBe(true);
    await database.client`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${work.attemptID})`;
    expect(await waits.admit(work.attemptID)).toBe(true);
    await database.client`UPDATE factory.change_agent_session SET stop_pending=true WHERE change_id=${work.changeID}`;
    expect(await waits.launch(work.attemptID, create)).toBeUndefined();
    await database.client`UPDATE factory.change_agent_session SET stop_pending=false,active_turn_id=${next.turn.id} WHERE change_id=${work.changeID}`;
    expect(await waits.launch(work.attemptID, create)).toBeUndefined();
    expect(creates).toBe(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

test("human takeover can restart Ticket compute while its Agent remains stopped", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const waits = createComputeWait(database);
  try {
    const work = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${work.attemptID}`;
    await database.client`UPDATE factory.change_agent_session SET state='stopped',stop_pending=false WHERE change_id=${work.changeID}`;
    await database.client`UPDATE factory.change_writer SET state='human',user_id=${work.userID} WHERE change_id=${work.changeID}`;
    let creates = 0;
    const create = async () => {
      creates++;
      return true;
    };
    expect(await waits.launch(work.attemptID, create)).toBe(true);
    await database.client`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${work.attemptID})`;
    expect(await waits.admit(work.attemptID)).toBe(true);
    expect(await waits.launch(work.attemptID, create)).toBe(true);
    expect(creates).toBe(2);
    for (const state of ["agent", "handoff", "unassigned"]) {
      await database.client`UPDATE factory.change_writer SET state=${state},user_id=NULL,
        turn_id=${state === "agent" ? crypto.randomUUID() : null},
        requested_by=${state === "handoff" ? work.userID : null},
        request_id=${state === "handoff" ? crypto.randomUUID() : null}
        WHERE change_id=${work.changeID}`;
      expect(await waits.launch(work.attemptID, create)).toBeUndefined();
    }
    await database.client`UPDATE factory.change_writer SET state='human',user_id=${work.userID} WHERE change_id=${work.changeID}`;
    await database.client`UPDATE factory.change_agent_session SET stop_pending=true WHERE change_id=${work.changeID}`;
    expect(await waits.launch(work.attemptID, create)).toBeUndefined();
    expect(creates).toBe(2);
  } finally {
    await database.client.end({ timeout: 2 });
    await owned.dispose();
  }
}, 30_000);

test("capacity wait retains exact runtime identity, serializes release and refuses revoked authority", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const waits = createComputeWait(database);
  try {
    const work = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${work.attemptID}`;
    await database.client`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${work.attemptID})`;
    await database.client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
      VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), sandboxes: 0 })}::jsonb,'UTC',${work.userID})`;
    const [identity] =
      await database.client`SELECT id,revision,generation,kubernetes_namespace,parent_connector_token_hash FROM factory.runtime_attempt WHERE id=${work.attemptID}`;
    expect(await database.client.begin((sql) => computeAllocationIn(sql, null))).toEqual({
      sandboxes: 0,
      cpuMilli: 0,
      memoryMiB: 0,
    });
    expect(await waits.admit(work.attemptID)).toBe(false);
    expect(await database.client`SELECT attempt_id FROM factory.runtime_compute_wait`).toHaveLength(
      1,
    );
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify({ ...defaultExecutionPolicy(), sandboxes: 1 })}::jsonb WHERE scope='factory'`;
    expect(
      (await Promise.all([waits.admit(work.attemptID), waits.admit(work.attemptID)])).filter(
        Boolean,
      ),
    ).toHaveLength(1);
    expect(await database.client.begin((sql) => computeAllocationIn(sql, null))).toEqual({
      sandboxes: 1,
      cpuMilli: 500,
      memoryMiB: 1024,
    });
    expect(
      (
        await database.client`SELECT id,revision,generation,kubernetes_namespace,parent_connector_token_hash FROM factory.runtime_attempt WHERE id=${work.attemptID}`
      )[0],
    ).toEqual(identity);
    let creates = 0;
    await waits.launch(work.attemptID, async () => {
      creates++;
      return true;
    });
    expect(creates).toBe(1);
    // Reductions retain admitted compute instead of evicting it.
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify({ ...defaultExecutionPolicy(), sandboxes: 0 })}::jsonb WHERE scope='factory'`;
    expect(
      (
        await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${work.attemptID}`
      )[0]?.["state"],
    ).toBe("create-intended");
    await database.client`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${work.attemptID})`;
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${work.projectID} AND user_id=${work.userID}`;
    await waits.launch(work.attemptID, async () => {
      creates++;
      return true;
    });
    expect(creates).toBe(1);
    expect(await waits.admit(work.attemptID)).toBe(false);
    expect(
      (
        await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${work.attemptID}`
      )[0]?.["state"],
    ).toBe("stop-intended");
    expect(await database.client`SELECT attempt_id FROM factory.runtime_compute_wait`).toHaveLength(
      0,
    );
  } finally {
    await database.client.end();
    await owned.dispose();
  }
}, 60000);

test("CPU, memory and Project ceilings include pending cleanup and count an adopted reserve once", async () => {
  const isolated = await factoryProcess();
  const database = isolated.connect();
  let pool: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  try {
    const work = await fixture(undefined, undefined, database);
    const setFactory = async (cpuMilli: number | null, memoryMiB: number | null) => {
      await database.client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
        VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), cpuMilli, memoryMiB })}::jsonb,'UTC',${work.userID})
        ON CONFLICT(scope) DO UPDATE SET policy=EXCLUDED.policy`;
    };
    await setFactory(500, null);
    await expect(
      database.client.begin((sql) => admitComputeIn(sql, work.projectID, "staging")),
    ).rejects.toMatchObject({ code: "conflict" });
    await setFactory(null, 1024);
    await expect(
      database.client.begin((sql) => admitComputeIn(sql, work.projectID, "staging")),
    ).rejects.toMatchObject({ code: "conflict" });
    await setFactory(2000, 4096);
    await database.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
      VALUES(${work.projectID},1,${JSON.stringify({ ...defaultExecutionPolicy(), sandboxes: 1 })}::jsonb,${work.userID})`;
    await expect(
      database.client.begin((sql) => admitComputeIn(sql, work.projectID, "staging")),
    ).rejects.toMatchObject({ code: "conflict" });
    await database.client`UPDATE factory.runtime_attempt SET state='cleanup-failed' WHERE id=${work.attemptID}`;
    expect(await database.client.begin((sql) => computeAllocationIn(sql, null))).toEqual({
      sandboxes: 1,
      cpuMilli: 500,
      memoryMiB: 1024,
    });
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${work.attemptID}`;
    await setFactory(300, 768);
    await database.client`UPDATE factory.execution_policy
      SET policy=${JSON.stringify({ ...defaultExecutionPolicy(), sandboxes: 2 })}::jsonb
      WHERE scope=${work.projectID}`;
    const image = `registry.invalid/owned@sha256:${"1".repeat(64)}`;
    const reserve = createReserveStore(
      defaultReservePolicy,
      { staging: image, verification: image },
      ownedFactoryboxProfile,
    );
    pool = await executionPoolFixture(
      database,
      reserve,
      ownedFactoryboxProfile,
      { staging: image, verification: image },
      { projectID: work.projectID, userID: work.userID },
    );
    const revision = pool.revision;
    const template = await pool.prepareTemplate();
    if (!template) throw new Error("Owned template is missing");
    const [slot] = await database.client.begin((sql) => reserve.plan(sql));
    if (!slot) throw new Error("Owned reserve missing");
    expect(slot.templateID).toBe(template.id);
    expect(await database.client.begin((sql) => computeAllocationIn(sql, null))).toEqual({
      sandboxes: 3,
      cpuMilli: 300,
      memoryMiB: 768,
    });
    expect(await database.client.begin((sql) => computeAllocationIn(sql, work.projectID))).toEqual({
      sandboxes: 1,
      cpuMilli: 100,
      memoryMiB: 256,
    });
    await reserve.observe(database.client, slot.id, {
      namespaceUID: "owned-ns",
      podUID: "owned-pod",
      claimUID: "owned-pvc",
      ready: false,
      factoryboxIdentity: { epoch: "owned" },
      factoryboxPreparation: { bundle: "owned" },
    });
    const standby = template.factoryboxStandby as {
      sandboxID: string;
      owner: string;
      snapshotID: string;
      checkpointSHA256: string;
    };
    expect(
      await reserve.intendFork(database.client, slot.id, {
        action: "fork",
        sandboxID: `runtime-${slot.id.replaceAll("-", "")}`,
        sourceSandboxID: standby.sandboxID,
        sourceOwner: standby.owner,
        snapshotID: standby.snapshotID,
        checkpointSHA256: standby.checkpointSHA256,
      }),
    ).toBe(true);
    expect(await reserve.intendStandby(database.client, slot.id, "pause")).toBe(true);
    await reserve.observe(database.client, slot.id, {
      namespaceUID: "owned-ns",
      podUID: "owned-pod",
      claimUID: "owned-pvc",
      ready: true,
      factoryboxPaused: true,
      factoryboxStandby: { ...standby, anonymousBytes: 0, snapshotResidentBytes: 0 },
    });
    const attemptID = crypto.randomUUID();
    await database.client.begin(async (sql) => {
      const adopted = await reserve.admit(sql, attemptID, "staging", {
        projectID: work.projectID,
        kind: "staging",
      });
      expect(adopted?.id).toBe(slot.id);
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${attemptID},${work.projectID},'staging',2,${revision},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${work.userID})`;
      await freezeRuntimeArtifacts(sql, attemptID, {
        hostImages: { staging: image, verification: image, development: image, build: image },
        browserToolsImage: image,
      });
    });
    expect(await database.client.begin((sql) => computeAllocationIn(sql, null))).toEqual({
      sandboxes: 3,
      cpuMilli: 300,
      memoryMiB: 768,
    });
    expect(await database.client.begin((sql) => computeAllocationIn(sql, work.projectID))).toEqual({
      sandboxes: 2,
      cpuMilli: 200,
      memoryMiB: 512,
    });
    await setFactory(0, 0);
    expect((await reserve.assigned(database.client, attemptID))?.state).toBe("assigned");
    await expect(
      database.client.begin((sql) => admitComputeIn(sql, work.projectID, "staging")),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await pool?.cleanup();
    await database.client.end();
    await isolated.dispose();
  }
}, 60000);
