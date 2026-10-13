import { expect, test } from "bun:test";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import { defaultReservePolicy, type ReserveRole } from "../../packages/runtime-domain/src/reserve";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

const images = {
  staging: `registry.invalid/base@sha256:${"1".repeat(64)}`,
  verification: `registry.invalid/check@sha256:${"2".repeat(64)}`,
};
const artifacts = {
  hostImages: {
    staging: images.staging,
    verification: images.verification,
    development: images.staging,
    build: images.staging,
  },
  browserToolsImage: `registry.invalid/browser@sha256:${"3".repeat(64)}`,
};

test("reserve persists clean create intent, serializes claims, freezes assignment and counts every admission", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  const store = createReserveStore({ ...defaultReservePolicy, maxExecutionSlots: 3 }, images);
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    const planned = await database.client.begin(async (sql) => store.plan(sql));
    expect(planned).toHaveLength(1);
    const slot = planned[0];
    if (!slot) throw new Error("Expected one persisted execution slot");
    expect(slot.state).toBe("creating");
    expect(slot.role).toBe("staging");
    expect(slot.assignedAttemptID).toBeNull();
    expect(
      (await database.client.begin((sql) => store.plan(sql))).map((candidate) => candidate.id),
    ).toEqual([slot.id]);
    expect(await database.client`SELECT id FROM factory.execution_slot`).toHaveLength(1);
    await store.observe(database.client, slot.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: true,
    });
    const second = await database.client.begin((sql) => store.plan(sql));
    expect(second).toHaveLength(1);
    expect(second[0]?.role).toBe("verification");
    const verificationSlot = second[0];
    if (!verificationSlot) throw new Error("Expected an in-flight Verification slot");
    let generation = 40;
    async function admit(role?: ReserveRole) {
      const attemptID = crypto.randomUUID();
      return database.client.begin(async (sql) => {
        const claimed = await store.admit(sql, attemptID, role);
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,kubernetes_namespace,kubernetes_pod_name,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          VALUES(${attemptID},${owned.projectID},'staging',${generation++},${"a".repeat(40)},'create-intended',${claimed?.namespace ?? `factory-runtime-${attemptID.replaceAll("-", "").slice(0, 12)}`},${claimed ? "slot" : "runtime-1"},${"b".repeat(64)},${"c".repeat(64)},now(),${owned.userID})`;
        await freezeRuntimeArtifacts(sql, attemptID, artifacts);
        return { attemptID, claimed };
      });
    }
    const admissions = await Promise.all([admit("staging"), admit("staging")]);
    expect(admissions.filter((admission) => admission.claimed)).toHaveLength(1);
    const assigned = admissions.find((admission) => admission.claimed);
    if (!assigned) throw new Error("Expected exactly one claimed slot");
    expect((await store.assigned(database.client, assigned.attemptID))?.id).toBe(slot.id);
    await expect(admit()).rejects.toThrow("capacity is occupied");
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE state='create-intended'`,
    ).toHaveLength(2);
    for (const [field, value] of [
      ["state", "ready"],
      ["assigned_attempt_id", crypto.randomUUID()],
      ["runtime_host_image", images.verification],
      ["pod_uid", "replacement-pod"],
    ] as const)
      await expect(
        (async () => {
          await database.client.unsafe(
            `UPDATE factory.execution_slot SET ${field}=$1 WHERE id=$2`,
            [value, slot.id],
          );
        })(),
      ).rejects.toThrow();
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${assigned.attemptID}`;
    await store.usedRemoved(database.client, assigned.attemptID);
    expect((await store.assigned(database.client, assigned.attemptID))?.state).toBe("deleted");
    const refill = await database.client.begin((sql) => store.plan(sql));
    expect(
      refill.some((candidate) => candidate.id !== slot.id && candidate.role === "staging"),
    ).toBe(false);
    // The in-flight Verification slot consumes the one creation permit.
    await store.observe(database.client, verificationSlot.id, {
      namespaceUID: "second-ns",
      podUID: "second-pod",
      claimUID: "second-claim",
      ready: true,
    });
    const next = await database.client.begin((sql) => store.plan(sql));
    expect(next.some((candidate) => candidate.role === "staging" && candidate.id !== slot.id)).toBe(
      true,
    );
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);

test("expired unassigned slots retire before admission and cannot return to the reserve", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  const store = createReserveStore({ ...defaultReservePolicy, readyPerRole: 0 }, images);
  const id = crypto.randomUUID();
  const namespace = `factory-reserve-${id.replaceAll("-", "").slice(0, 12)}`;
  try {
    await database.client`INSERT INTO factory.execution_slot(id,role,state,runtime_host_image,kubernetes_namespace,created_at,expires_at)
      VALUES(${id},'staging','creating',${images.staging},${namespace},now()-interval '16 minutes',now()-interval '1 second')`;
    await store.observe(database.client, id, {
      namespaceUID: "expired-ns",
      podUID: "expired-pod",
      claimUID: "expired-claim",
      ready: true,
    });
    const due = await database.client.begin((sql) => store.plan(sql));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ id, state: "retiring", assignedAttemptID: null });
    expect(
      await database.client.begin((sql) => store.admit(sql, crypto.randomUUID(), "staging")),
    ).toBeNull();
    await store.retired(database.client, id);
    expect(await database.client.begin((sql) => store.plan(sql))).toHaveLength(0);
    await expect(
      (async () => {
        await database.client`UPDATE factory.execution_slot SET state='ready' WHERE id=${id}`;
      })(),
    ).rejects.toThrow("cannot return");
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);

test("failed preparation retires within its budget without unbounded refill", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  const store = createReserveStore({ ...defaultReservePolicy, preparationMS: 1_000 }, images);
  try {
    const [slot] = await database.client.begin((sql) => store.plan(sql));
    expect(slot).toBeDefined();
    if (!slot) throw new Error("Expected one persisted execution slot");
    await Bun.sleep(1_050);
    const due = await database.client.begin((sql) => store.plan(sql));
    expect(due.find((candidate) => candidate.id === slot.id)?.state).toBe("retiring");
    await store.retired(database.client, slot.id);
    const pending = await database.client.begin((sql) => store.plan(sql));
    expect(pending.filter((candidate) => candidate.role === slot.role)).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.execution_slot WHERE role=${slot.role}`,
    ).toHaveLength(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);
