// Real Factory producer/reserve SQL in an isolated database, with explicitly
// synthetic native observations. Never relabel these as live pool hit rate,
// prepared App latency or a runtime/template promotion.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import { executionPoolFixture } from "../../test/fixtures/execution-pool";
import { factoryProcess } from "../../test/fixtures/factory-process";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/pool-lookup-benchmark", owner);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
const image = `registry.invalid/runtime@sha256:${"1".repeat(64)}`;
const images = { staging: image, verification: image };
const profile = {
  image: `registry.invalid/worker@sha256:${"a".repeat(64)}`,
  executableSHA256: "b".repeat(64),
  architecture: "amd64" as const,
  nodeName: "owned-node",
  kernel: "owned-kernel",
  boundedBytes: 8589934592 as const,
  claimGiB: 32 as const,
};
await save("intent.json", {
  owner,
  scope:
    "Isolated PostgreSQL producer/reserve lookup only; no Kubernetes, native Sandbox, real dependency image or model calls",
  nativeObservations: "synthetic",
  automaticReserveTarget: 0,
});
const host = await factoryProcess(undefined, { FACTORY_EXECUTION_RESERVE_TARGET: "0" });
const database = host.connect();
const store = createReserveStore(defaultReservePolicy, images, profile);
let fixture: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
const samples: Array<{ mode: "hit" | "miss"; elapsedMS: number; matched: boolean }> = [];
const rollback = new Error("Owned lookup rollback");
try {
  fixture = await executionPoolFixture(database, store, profile, images);
  const projectID = fixture.projectID;
  const template = await fixture.prepareTemplate();
  if (!template) throw new Error("Synthetic controller template is missing");
  const planned = await database.client.begin((sql) => store.plan(sql));
  const slot = planned.find((value) => value.templateID === template.id);
  if (!slot) throw new Error("Controller did not plan an exact template descendant");
  const source = template.factoryboxStandby as {
    sandboxID: string;
    owner: string;
    snapshotID: string;
    checkpointSHA256: string;
  };
  await store.observe(database.client, slot.id, {
    namespaceUID: "synthetic-namespace",
    podUID: "synthetic-pod",
    claimUID: "synthetic-claim",
    ready: false,
    factoryboxIdentity: template.factoryboxIdentity,
    factoryboxPreparation: { kind: "fork" },
  });
  if (
    !(await store.intendFork(database.client, slot.id, {
      action: "fork",
      sandboxID: `runtime-${slot.id.replaceAll("-", "")}`,
      sourceSandboxID: source.sandboxID,
      sourceOwner: source.owner,
      snapshotID: source.snapshotID,
      checkpointSHA256: source.checkpointSHA256,
    }))
  )
    throw new Error("Controller refused its exact fixture ancestry");
  await store.intendStandby(database.client, slot.id, "pause");
  await store.observe(database.client, slot.id, {
    namespaceUID: "synthetic-namespace",
    podUID: "synthetic-pod",
    claimUID: "synthetic-claim",
    ready: true,
    factoryboxPaused: true,
    factoryboxStandby: {
      ...source,
      sandboxID: `runtime-${slot.id.replaceAll("-", "")}`,
      owner: "9".repeat(32),
      anonymousBytes: 0,
      snapshotResidentBytes: 0,
    },
  });
  const before = await store.get(database.client, slot.id);
  for (let block = 0; block < 10; block++) {
    for (const mode of ["hit", "miss", "miss", "hit"] as const) {
      try {
        await database.client.begin(async (sql) => {
          // Simulate an empty ready pool, inside a rolled-back transaction.
          // No runtime is retired or mutated, and setup is outside lookup time.
          if (mode === "miss")
            await sql`UPDATE factory.execution_slot SET state='retiring' WHERE id=${slot.id}`;
          const started = performance.now();
          const result = await store.admit(sql, crypto.randomUUID(), "verification", {
            projectID,
            kind: "verification",
          });
          const elapsedMS = performance.now() - started;
          if (mode === "hit" ? result?.id !== slot.id : result !== null)
            throw new Error("Controller hit/miss result disagreed with the exact pool fixture");
          samples.push({ mode, elapsedMS, matched: true });
          throw rollback;
        });
      } catch (cause) {
        if (cause !== rollback) throw cause;
      }
    }
  }
  const after = await store.get(database.client, slot.id);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Read-only benchmark changed its original slot state");
  await save("result.json", {
    passed: true,
    samples,
    slotUnchanged: true,
    alternatingOrder: "ABBA",
    samplesPerMode: 20,
    nativeObservations: "synthetic",
    nativeQualified: false,
    scope:
      "Actual Factory SQL hit/miss decision cost only; not real pool hit frequency, native activation latency, an optimization or AKS evidence",
  });
} catch (cause) {
  await save("failure.json", {
    error: cause instanceof Error ? cause.message : "Pool lookup measurement failed",
    samples,
  });
  throw cause;
} finally {
  await fixture?.cleanup();
  await database.client.end({ timeout: 2 });
  await host.dispose();
  await save("cleanup.json", {
    owner,
    isolatedFactoryDisposed: true,
    kubernetesResourcesCreated: false,
  });
}
console.log(JSON.stringify({ evidence: directory, passed: true, nativeQualified: false }));
