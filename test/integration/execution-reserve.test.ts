import { expect, test } from "bun:test";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import {
  defaultReservePolicy,
  type ReservePolicy,
} from "../../packages/runtime-domain/src/reserve";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

const image = `registry.invalid/base@sha256:${"1".repeat(64)}`;
const images = { staging: image, verification: image };
const profile = {
  image: `registry.invalid/worker@sha256:${"a".repeat(64)}`,
  executableSHA256: "b".repeat(64),
  architecture: "amd64" as const,
  nodeName: "owned-node",
  kernel: "6.12.0",
  boundedBytes: 8589934592 as const,
  claimGiB: 32 as const,
};
async function setup(policy: ReservePolicy = defaultReservePolicy) {
  const host = await factoryProcess(),
    database = host.connect();
  const admitted = createReserveStore({ ...policy, readyTarget: 2 }, images, profile);
  try {
    const owned = await executionPoolFixture(database, admitted, profile, images);
    const store = createReserveStore(policy, images, profile);
    return {
      ...owned,
      database,
      store,
      async dispose() {
        await owned.cleanup();
        await database.client.end({ timeout: 2 });
        await host.dispose();
      },
    };
  } catch (cause) {
    await database.client.end({ timeout: 2 });
    await host.dispose();
    throw cause;
  }
}

test("parallel admissions claim one ready Fork once, keep the template private, and count cold admissions", async () => {
  const f = await setup({ ...defaultReservePolicy, maxExecutionSlots: 5 });
  try {
    const template = await f.prepareTemplate();
    if (!template) throw new Error("Missing source template");
    const [slot] = await f.database.client.begin((sql) => f.store.plan(sql));
    if (!slot) throw new Error("Missing Fork");
    await f.store.observe(f.database.client, slot.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: false,
      factoryboxIdentity: template.factoryboxIdentity,
      factoryboxPreparation: { kind: "fork" },
    });
    const source = template.factoryboxStandby as {
      sandboxID: string;
      owner: string;
      snapshotID: string;
      checkpointSHA256: string;
    };
    await f.store.intendFork(f.database.client, slot.id, {
      action: "fork",
      sandboxID: `runtime-${slot.id.replaceAll("-", "")}`,
      sourceSandboxID: source.sandboxID,
      sourceOwner: source.owner,
      snapshotID: source.snapshotID,
      checkpointSHA256: source.checkpointSHA256,
    });
    await f.store.intendStandby(f.database.client, slot.id, "pause");
    await f.store.observe(f.database.client, slot.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: true,
      factoryboxPaused: true,
      factoryboxStandby: { ...source, anonymousBytes: 0, snapshotResidentBytes: 0 },
    });
    const [preparing] = await f.database.client.begin((sql) => f.store.plan(sql));
    expect(preparing?.templateID).toBe(template.id);
    let generation = 2;
    async function admit() {
      const id = crypto.randomUUID();
      return f.database.client.begin(async (sql) => {
        const selected = await f.store.admit(sql, id, "staging", {
          projectID: f.projectID,
          kind: "staging",
        });
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          VALUES(${id},${f.projectID},'staging',${generation++},${f.revision},'create-intended',${"a".repeat(64)},${"b".repeat(64)},now(),${f.userID})`;
        await freezeRuntimeArtifacts(sql, id, f.artifactConfiguration);
        return { id, selected };
      });
    }
    const claims = await Promise.all([admit(), admit()]);
    expect(claims.filter((value) => value.selected)).toHaveLength(1);
    expect(claims.find((value) => value.selected)?.selected?.id).toBe(slot.id);
    expect((await f.store.get(f.database.client, template.id))?.assignedAttemptID).toBeNull();
    await expect(admit()).rejects.toThrow("capacity is occupied");
    for (const [field, value] of [
      ["state", "ready"],
      ["assigned_attempt_id", crypto.randomUUID()],
      ["pod_uid", "replacement"],
      ["factorybox_pause_attempted", false],
    ] as const)
      await expect(
        (async () => {
          await f.database.client.unsafe(
            `UPDATE factory.execution_slot SET ${field}=$1 WHERE id=$2`,
            [value, slot.id],
          );
        })(),
      ).rejects.toThrow();
  } finally {
    await f.dispose();
  }
}, 60_000);

test("disabled reserve retires unused prepared execution without returning it to the pool", async () => {
  const f = await setup({ ...defaultReservePolicy, readyTarget: 0 });
  try {
    await f.prepareTemplate();
    const due = await f.database.client.begin((sql) => f.store.plan(sql));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ id: f.template.id, state: "retiring", assignedAttemptID: null });
    expect(
      await f.database.client.begin((sql) =>
        f.store.admit(sql, crypto.randomUUID(), "staging", {
          projectID: f.projectID,
          kind: "staging",
        }),
      ),
    ).toBeNull();
    await f.store.retired(f.database.client, f.template.id);
    expect(await f.database.client.begin((sql) => f.store.plan(sql))).toHaveLength(0);
    await expect(
      (async () => {
        await f.database
          .client`UPDATE factory.execution_slot SET state='ready' WHERE id=${f.template.id}`;
      })(),
    ).rejects.toThrow("cannot return");
  } finally {
    await f.dispose();
  }
}, 60_000);

test("retirement retains exact immutable intent and outcome across controller recovery", async () => {
  const f = await setup({ ...defaultReservePolicy, readyTarget: 0 });
  try {
    await f.prepareTemplate();
    await f.store.retire(f.database.client, f.template.id);
    const request = {
      version: 1,
      storeID: "a".repeat(32),
      epoch: "b".repeat(32),
      sandboxID: `runtime-${f.template.id.replaceAll("-", "")}`,
      checkpoints: [],
      resumes: [],
      backing: {
        sandbox_id: `runtime-${f.template.id.replaceAll("-", "")}`,
        sandbox_owner: "c".repeat(32),
        input_sha256: "d".repeat(64),
      },
    };
    const observation = {
      version: 1,
      request,
      receipts: [
        { action: "retire-sandbox", intentSHA256: "e".repeat(64), completedAt: "complete" },
      ],
    };
    await expect(
      f.store.completeRetirement(f.database.client, f.template.id, observation),
    ).rejects.toThrow("original request");
    await f.store.intendRetirement(f.database.client, f.template.id, request);
    const recovered = createReserveStore(
      { ...defaultReservePolicy, readyTarget: 0 },
      images,
      profile,
    );
    await recovered.intendRetirement(f.database.client, f.template.id, request);
    await expect(
      recovered.intendRetirement(f.database.client, f.template.id, {
        ...request,
        epoch: "f".repeat(32),
      }),
    ).rejects.toThrow("original request");
    await expect(
      recovered.completeRetirement(f.database.client, f.template.id, {
        ...observation,
        request: { ...request, epoch: "f".repeat(32) },
      }),
    ).rejects.toThrow("original request");
    await recovered.completeRetirement(f.database.client, f.template.id, observation);
    await recovered.completeRetirement(f.database.client, f.template.id, observation);
    await expect(
      recovered.completeRetirement(f.database.client, f.template.id, {
        ...observation,
        receipts: [],
      }),
    ).rejects.toThrow("outcome");
    await expect(
      (async () => {
        await f.database
          .client`UPDATE factory.execution_slot SET factorybox_retirement_observation=NULL WHERE id=${f.template.id}`;
      })(),
    ).rejects.toThrow("immutable");
    await recovered.retired(f.database.client, f.template.id);
    const [saved] = await f.database
      .client`SELECT state,factorybox_retirement_request AS request,factorybox_retirement_observation AS observation
      FROM factory.execution_slot WHERE id=${f.template.id}`;
    expect(saved).toMatchObject({ state: "deleted", request, observation });
  } finally {
    await f.dispose();
  }
}, 60_000);

test("cold preparation retains the original 420 second deadline, without resetting stale identities", async () => {
  const f = await setup();
  try {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, age] of [240, 421].entries()) {
      const id = fixtureValue(ids[index], "ids[index]");
      const recipe = { ...(f.template.projectRecipe as object), runtimeAttemptId: id };
      await f.database.client`INSERT INTO factory.execution_slot
        (id,project_id,staging_attempt_id,revision,template_key,project_recipe,seed_expires_at,role,state,runtime_host_image,created_at,expires_at,factorybox_profile)
        VALUES(${id},${f.projectID},${f.stagingID},${f.revision},${String(index + 1).repeat(64)},${JSON.stringify(recipe)}::text::jsonb,
          now()+interval '10 minutes','staging','creating',${image},now()-${age}*interval '1 second',now()+interval '10 minutes',${JSON.stringify(profile)}::text::jsonb)`;
    }
    const due = await f.database.client.begin((sql) => f.store.plan(sql));
    expect(due.find((slot) => slot.id === ids[0])?.state).toBe("creating");
    expect(due.find((slot) => slot.id === ids[1])?.state).toBe("retiring");
    await f.store.defer(f.database.client, fixtureValue(ids[1], "ids[1]"));
    await f.database.client.begin((sql) => f.store.plan(sql));
    expect((await f.store.get(f.database.client, fixtureValue(ids[1], "ids[1]")))?.state).toBe(
      "retiring",
    );
    expect(await f.database.client`SELECT id FROM factory.execution_slot`).toHaveLength(3);
  } finally {
    await f.dispose();
  }
}, 60_000);
