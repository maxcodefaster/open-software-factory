import { expect, test } from "bun:test";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

const image = `registry.invalid/runtime@sha256:${"1".repeat(64)}`;
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

test("the production pool plans two Project-bound Forks from one healthy immutable template", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const store = createReserveStore(defaultReservePolicy, images, profile);
  let owned: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  try {
    expect(await database.client.begin((sql) => store.plan(sql))).toHaveLength(0);
    owned = await executionPoolFixture(database, store, profile, images);
    const template = await owned.prepareTemplate();
    if (!template) throw new Error("Missing template");
    const [configuration] = await database.client<Array<{ declaration: unknown }>>`
      SELECT declaration FROM factory.staging_configuration WHERE runtime_attempt_id=${owned.stagingID}`;
    expect(Object.keys(configuration?.declaration as object).sort()).toEqual([
      "channels",
      "devcontainerPath",
      "processes",
    ]);
    expect(JSON.stringify(configuration)).not.toContain("do-not-capture");
    await expect(
      (async () => {
        await database.client`UPDATE factory.staging_configuration SET declaration='{}'::jsonb WHERE runtime_attempt_id=${owned.stagingID}`;
      })(),
    ).rejects.toThrow("immutable");
    const [first] = await database.client.begin((sql) => store.plan(sql));
    if (!first) throw new Error("Missing first persisted Fork intent");
    expect(first).toMatchObject({
      templateID: template.id,
      projectID: owned.projectID,
      revision: owned.revision,
      state: "creating",
      assignedAttemptID: null,
    });
    expect(first.projectRecipe).toEqual(template.projectRecipe);
    expect(first.seedExpiresAt).toEqual(template.seedExpiresAt);
    await store.observe(database.client, first.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: false,
      factoryboxIdentity: template.factoryboxIdentity,
    });
    const source = template.factoryboxStandby as {
      sandboxID: string;
      owner: string;
      snapshotID: string;
      checkpointSHA256: string;
    };
    const request = {
      action: "fork",
      sandboxID: `runtime-${first.id.replaceAll("-", "")}`,
      sourceSandboxID: source.sandboxID,
      sourceOwner: source.owner,
      snapshotID: source.snapshotID,
      checkpointSHA256: source.checkpointSHA256,
    };
    expect(
      await store.intendFork(database.client, first.id, {
        ...request,
        sourceOwner: "0".repeat(32),
      }),
    ).toBe(false);
    expect(await store.intendFork(database.client, first.id, request)).toBe(true);
    expect(await store.intendFork(database.client, first.id, request)).toBe(false);
    expect(await store.intendStart(database.client, first.id)).toBe(false);
    await store.observe(database.client, first.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: false,
      factoryboxPreparation: { kind: "fork", request },
    });
    expect(await store.intendStandby(database.client, first.id, "pause")).toBe(true);
    await store.observe(database.client, first.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: true,
      factoryboxPaused: true,
      factoryboxStandby: {
        ...source,
        sandboxID: request.sandboxID,
        owner: "9".repeat(32),
        snapshotID: first.id.replaceAll("-", ""),
        anonymousBytes: 0,
        snapshotResidentBytes: 0,
      },
    });
    const [second] = await database.client.begin((sql) => store.plan(sql));
    if (!second) throw new Error("Missing second Fork");
    expect(second.templateID).toBe(template.id);
    expect(second.role).toBe(first.role);
    await store.observe(database.client, second.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: false,
      factoryboxIdentity: template.factoryboxIdentity,
      factoryboxPreparation: { kind: "fork" },
    });
    expect(
      await store.intendFork(database.client, second.id, {
        ...request,
        sandboxID: `runtime-${second.id.replaceAll("-", "")}`,
      }),
    ).toBe(true);
    await store.intendStandby(database.client, second.id, "pause");
    await store.observe(database.client, second.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: true,
      factoryboxPaused: true,
      factoryboxStandby: {
        ...source,
        sandboxID: `runtime-${second.id.replaceAll("-", "")}`,
        owner: "8".repeat(32),
        snapshotID: second.id.replaceAll("-", ""),
        anonymousBytes: 0,
        snapshotResidentBytes: 0,
      },
    });
    expect(
      await database.client`SELECT id FROM factory.execution_slot WHERE template_id IS NOT NULL AND state<>'deleted'`,
    ).toHaveLength(2);
    expect(
      await database.client.begin((sql) =>
        store.admit(sql, crypto.randomUUID(), "staging", {
          projectID: crypto.randomUUID(),
          kind: "staging",
        }),
      ),
    ).toBeNull();
    await expect(
      database.client.begin(async (sql) => {
        expect(
          (
            await store.admit(sql, crypto.randomUUID(), "verification", {
              projectID: fixtureValue(owned, "owned").projectID,
              kind: "verification",
            })
          )?.id,
        ).toBe(first.id);
        // No Runtime Attempt or external operation is commissioned by this
        // rolled-back lookup of the same role-independent pool.
        throw new Error("Owned role lookup rollback");
      }),
    ).rejects.toThrow("role lookup rollback");
    expect((await store.get(database.client, first.id))?.state).toBe("ready");
    const attemptID = crypto.randomUUID();
    await database.client.begin(async (sql) => {
      const selected = await store.admit(sql, attemptID, "staging", {
        projectID: fixtureValue(owned, "owned").projectID,
        kind: "staging",
      });
      expect(selected?.id).toBe(first.id);
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${attemptID},${fixtureValue(owned, "owned").projectID},'staging',2,${fixtureValue(owned, "owned").revision},'create-intended',${"a".repeat(64)},${"b".repeat(64)},now(),${fixtureValue(owned, "owned").userID})`;
      await freezeRuntimeArtifacts(
        sql,
        attemptID,
        fixtureValue(owned, "owned").artifactConfiguration,
      );
    });
    expect(await store.intendStandby(database.client, first.id, "resume")).toBe(true);
    expect(await store.intendStandby(database.client, first.id, "resume")).toBe(false);
    for (const [field, value] of [
      ["template_id", crypto.randomUUID()],
      ["factorybox_fork_attempted", false],
      ["factorybox_fork_request", null],
      ["assigned_attempt_id", crypto.randomUUID()],
    ] as const)
      await expect(
        (async () => {
          await database.client.unsafe(
            `UPDATE factory.execution_slot SET ${field}=$1 WHERE id=$2`,
            [value, first.id],
          );
        })(),
      ).rejects.toThrow();
    const [refill] = await database.client.begin((sql) => store.plan(sql));
    expect(refill?.templateID).toBe(template.id);
    expect(refill?.id).not.toBe(first.id);
    expect((await store.assigned(database.client, attemptID))?.state).toBe("assigned");
    await database.client`UPDATE factory.staging_preview SET runtime_attempt_id=NULL WHERE project_id=${owned.projectID}`;
    await database.client.begin((sql) => store.plan(sql));
    expect((await store.get(database.client, template.id))?.state).toBe("retiring");
    expect((await store.get(database.client, first.id))?.state).toBe("assigned");
  } finally {
    await owned?.cleanup();
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);
