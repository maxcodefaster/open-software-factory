import { expect, spyOn, test } from "bun:test";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../packages/runtime-domain/src/identity";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import type { ReserveClient } from "../../packages/runtime-kubernetes/src/reserve";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import {
  installOwnedRuntimeConfiguration,
  ownedFactoryboxProfile,
} from "../fixtures/runtime-configuration";

test("recovered Staging freezes its public configuration before any external create", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const images = {
    staging: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    verification: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  };
  const store = createReserveStore(defaultReservePolicy, images);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  let owned: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  let observed = false;
  let declaration: unknown;
  try {
    owned = await executionPoolFixture(database, store, ownedFactoryboxProfile, images);
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${owned.projectID},${owned.userID},'developer',${owned.userID})`;
    const secret = "owned-recovered-staging-configuration";
    const { attemptID } = runtimeIdentity(`staging:${owned.projectID}`, 2);
    const tokens = runtimeConnectorTokens(secret, attemptID, 2);
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.stagingID}`;
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${attemptID},${owned.projectID},'staging',2,${owned.revision},'create-intended',
        ${hashConnectorToken(tokens.parent)},${hashConnectorToken(tokens.child)},now(),${owned.userID})`;
    await freezeRuntimeArtifacts(database.client, attemptID, owned.artifactConfiguration);
    await database.client`UPDATE factory.staging_preview SET runtime_attempt_id=${attemptID}
      WHERE project_id=${owned.projectID}`;
    const controller = createRuntimeController(
      database,
      new RuntimeHub(async () => {}),
      secret,
      {
        prepareExecution: async () => {
          throw new Error("Staging must not allocate canonical source");
        },
      },
      {
        ...createKubernetesClient(),
        getNamespace: async () => null,
        getPod: async () => null,
        async apply() {
          const [saved] = await database.client<Array<{ declaration: unknown }>>`
            SELECT declaration FROM factory.staging_configuration WHERE runtime_attempt_id=${attemptID}`;
          declaration = saved?.declaration;
          observed = true;
          throw new Error("Owned fixture stops before the first external create");
        },
      },
      async () => "",
    );
    await controller.recover();
    await eventually(
      async () => observed,
      (value) => value,
      "Staging recovery never reached its external-create boundary",
    );
    await eventually(
      () => controller.get(attemptID),
      (value) => value?.state === "failed",
      "Owned rejected create did not settle",
    );
    expect(declaration).toMatchObject({
      devcontainerPath: ".devcontainer/devcontainer.json",
      channels: [{ name: "app", kind: "app" }],
      processes: [{ name: "app", command: ["node", "server.js"] }],
    });
  } finally {
    await owned?.cleanup();
    await database.client.end({ timeout: 2 });
    await host.dispose();
    diagnostic.mockRestore();
    restoreConfiguration();
  }
}, 30_000);

test("early Fork Connector readiness waits for its retained native Start observation", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const images = {
    staging: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    verification: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  };
  const store = createReserveStore(defaultReservePolicy, images);
  let owned: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  try {
    owned = await executionPoolFixture(database, store, ownedFactoryboxProfile, images);
    const { projectID, revision, userID, artifactConfiguration } = owned;
    const template = await owned.prepareTemplate();
    const [slot] = await database.client.begin((sql) => store.plan(sql));
    if (!template || !slot) throw new Error("Owned Fork fixture missing");
    const sandboxID = `runtime-${slot.id.replaceAll("-", "")}`;
    await store.observe(database.client, slot.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: false,
      factoryboxIdentity: template.factoryboxIdentity,
      factoryboxPreparation: { kind: "fork" },
    });
    await store.intendFork(database.client, slot.id, {
      action: "fork",
      sandboxID,
      sourceSandboxID: `runtime-${template.id.replaceAll("-", "")}`,
      sourceOwner: "e".repeat(32),
      snapshotID: template.id.replaceAll("-", ""),
      checkpointSHA256: "f".repeat(64),
    });
    await store.intendStandby(database.client, slot.id, "pause");
    await store.observe(database.client, slot.id, {
      namespaceUID: "owned-namespace",
      podUID: "owned-pod",
      claimUID: "owned-claim",
      ready: true,
      factoryboxPaused: true,
      factoryboxStandby: {
        sandboxID,
        owner: "f".repeat(32),
        snapshotID: slot.id.replaceAll("-", ""),
        checkpointSHA256: "e".repeat(64),
        inputSHA256: "a".repeat(64),
        anonymousBytes: 0,
        snapshotResidentBytes: 0,
      },
    });
    const attemptID = crypto.randomUUID();
    await database.client.begin(async (sql) => {
      await store.admit(sql, attemptID, "staging", {
        projectID,
        kind: "staging",
      });
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${attemptID},${projectID},'staging',2,${revision},'create-intended',${"a".repeat(64)},${"b".repeat(64)},now(),${userID})`;
      await freezeRuntimeArtifacts(sql, attemptID, artifactConfiguration);
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${attemptID}`;
    });
    const controller = createRuntimeController(
      database,
      new RuntimeHub(async () => {}),
      "owned-early-fork-readiness",
      {
        prepareExecution: async () => {
          throw new Error("A Fork must not replace canonical source");
        },
      },
    );
    await controller.status(attemptID, "ready");
    expect((await controller.get(attemptID))?.state).toBe("starting");
    // The real native adapter commits these observations after binding the
    // assigned Fork. This controller fixture performs no native operation.
    await database.client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request)
      VALUES(${attemptID},${JSON.stringify({ sandboxID })}::text::jsonb)`;
    await controller.status(attemptID, "ready");
    expect((await controller.get(attemptID))?.state).toBe("starting");
    await database.client`INSERT INTO factory.factorybox_lifecycle_operation(runtime_attempt_id,action,attempted_at)
      VALUES(${attemptID},'start',now())`;
    await controller.status(attemptID, "ready");
    expect((await controller.get(attemptID))?.state).toBe("starting");
    await database.client`UPDATE factory.factorybox_lifecycle_operation
      SET completed_at=now(),observation=${JSON.stringify({ id: sandboxID, phase: "running" })}::text::jsonb
      WHERE runtime_attempt_id=${attemptID} AND action='start'`;
    await controller.status(attemptID, "ready");
    expect((await controller.get(attemptID))?.state).toBe("ready");
    await controller.status(attemptID, "ready");
    expect(
      await database.client`SELECT runtime_attempt_id FROM factory.factorybox_runtime WHERE runtime_attempt_id=${attemptID}`,
    ).toHaveLength(1);
    await database.client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
      WHERE id=${attemptID}`;
    await controller.status(attemptID, "ready");
    expect((await controller.get(attemptID))?.state).toBe("stopping");
  } finally {
    await owned?.cleanup();
    await database.client.end({ timeout: 2 });
    await host.dispose();
    restoreConfiguration();
  }
}, 30_000);

test("reserve preparation waits for the shared native worker instead of colliding with another Sandbox", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const holder = database.coordination();
  const images = {
    staging: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    verification: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  };
  const store = createReserveStore(defaultReservePolicy, images);
  const entered = Promise.withResolvers<void>();
  const controller = createExecutionReserve(database, images, defaultReservePolicy, {
    async prepare() {
      entered.resolve();
      return {
        namespaceUID: "namespace",
        podUID: "pod",
        claimUID: "claim",
        ready: false,
        failed: false,
      };
    },
    async retire() {
      throw new Error("Unexpected retirement");
    },
    async activate() {
      throw new Error("Unexpected activation");
    },
    async removeAssigned() {
      throw new Error("Unexpected cleanup");
    },
  });
  let owned: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  let pending: Promise<void> | undefined;
  let held = false;
  try {
    owned = await executionPoolFixture(database, store, ownedFactoryboxProfile, images);
    await holder`SELECT pg_advisory_lock(hashtext('factorybox-worker-lifecycle'))`;
    held = true;
    pending = controller.reconcile();
    await Promise.race([
      entered.promise.then(() => {
        throw new Error("Reserve preparation collided with the already busy native worker");
      }),
      eventually(
        () => database.client`
          SELECT pid FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event='advisory' AND query LIKE '%factorybox-worker-lifecycle%'`,
        (rows) => rows.length === 1,
        "Reserve preparation never waited for the shared worker",
      ),
    ]);
    await holder`SELECT pg_advisory_unlock(hashtext('factorybox-worker-lifecycle'))`;
    held = false;
    await pending;
    await entered.promise;
  } finally {
    if (held) await holder`SELECT pg_advisory_unlock(hashtext('factorybox-worker-lifecycle'))`;
    await holder.end({ timeout: 1 });
    await pending;
    await controller.close();
    await owned?.cleanup();
    await database.client.end({ timeout: 2 });
    await host.dispose();
    restoreConfiguration();
  }
}, 30_000);

test("queued reserve controllers use the preparation committed under the slot lock before admitting Start", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controllers: ReturnType<typeof createExecutionReserve>[] = [];
  const pending: Promise<void>[] = [];
  const images = {
    staging: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    verification: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  };
  const store = createReserveStore(defaultReservePolicy, images);
  const prepared = { bundle: "owned-private-input" };
  const observations = { namespaceUID: "namespace", podUID: "pod", claimUID: "claim" };
  const starts: string[] = [];
  const calls: Array<{ prepared: boolean; startAllowed: boolean; startAttempted: boolean }> = [];
  let owned: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  try {
    owned = await executionPoolFixture(database, store, ownedFactoryboxProfile, images);
    const [slot] = await database.client.begin((sql) => store.plan(sql));
    if (!slot) throw new Error("Owned reserve slot missing");
    await store.observe(database.client, slot.id, {
      ...observations,
      ready: false,
      factoryboxIdentity: { epoch: "owned" },
    });
    await store.intendSourceImport(database.client, slot.id, "d".repeat(64));
    await store.completeSourceImport(database.client, slot.id, { sha256: "d".repeat(64) });
    await database.client`UPDATE factory.execution_slot SET reconcile_after=now() WHERE id=${slot.id}`;
    const adapter: ReserveClient = {
      async prepare(current, options) {
        if (!options) throw new Error("Expected durable Start admission");
        calls.push({
          prepared: Boolean(current.factoryboxPreparation),
          startAllowed: options.startAllowed,
          startAttempted: current.factoryboxStartAttempted === true,
        });
        if (!current.factoryboxPreparation) {
          entered.resolve();
          await release.promise;
          return {
            ...observations,
            ready: false,
            failed: false,
            factoryboxPreparation: prepared,
          };
        }
        if (options.startAllowed) starts.push(current.id);
        if (!starts.includes(current.id))
          throw new Error("Native Sandbox record is absent despite recorded Start intent");
        return { ...observations, ready: false, failed: false };
      },
      async retire() {
        throw new Error("Unexpected retirement");
      },
      async activate() {
        throw new Error("Unexpected assignment");
      },
      async removeAssigned() {
        throw new Error("Unexpected assigned cleanup");
      },
    };
    const first = createExecutionReserve(database, images, defaultReservePolicy, adapter);
    const second = createExecutionReserve(database, images, defaultReservePolicy, adapter);
    controllers.push(first, second);
    pending.push(first.reconcile());
    await entered.promise;
    pending.push(second.reconcile());
    // Prove the second controller has planned the old slot and is waiting on
    // the real PostgreSQL lock. A sleep would not establish this interleaving.
    await eventually(
      () => database.client`
        SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event='advisory' AND query LIKE '%pg_advisory_lock%'`,
      (rows) => rows.length === 1,
      "Second reserve controller never waited on the first slot owner",
    );
    release.resolve();
    await Promise.all(pending);
    expect(calls.slice(0, 2)).toEqual([
      { prepared: false, startAllowed: false, startAttempted: false },
      { prepared: true, startAllowed: true, startAttempted: false },
    ]);
    expect(starts).toEqual([slot.id]);
    const [persisted] = await database.client`
      SELECT state,factorybox_start_attempted AS started,factorybox_preparation AS preparation
        FROM factory.execution_slot WHERE id=${slot.id}`;
    expect(persisted).toEqual({ state: "creating", started: true, preparation: prepared });
    await database.client`UPDATE factory.execution_slot SET reconcile_after=now() WHERE id=${slot.id}`;
    await first.reconcile();
    expect(calls.at(-1)).toEqual({
      prepared: true,
      startAllowed: false,
      startAttempted: true,
    });
    expect(starts).toEqual([slot.id]);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await Promise.all(controllers.map((controller) => controller.close()));
    await owned?.cleanup();
    await database.client.end({ timeout: 2 });
    await host.dispose();
    restoreConfiguration();
  }
}, 30_000);

test("a missing native record never authorizes another Start after durable admission", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const images = {
    staging: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    verification: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  };
  const store = createReserveStore(defaultReservePolicy, images);
  const admissions: boolean[] = [];
  let owned: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const controller = createExecutionReserve(database, images, defaultReservePolicy, {
    async prepare(slot, options) {
      if (!options) throw new Error("Expected durable Start admission");
      admissions.push(options.startAllowed);
      expect(slot.factoryboxPreparation).toEqual({ bundle: "owned-private-input" });
      expect(slot.factoryboxStartAttempted).toBe(true);
      throw new Error("Native Sandbox record is absent");
    },
    async retire() {
      throw new Error("Unexpected retirement");
    },
    async activate() {
      throw new Error("Unexpected assignment");
    },
    async removeAssigned() {
      throw new Error("Unexpected assigned cleanup");
    },
  });
  try {
    owned = await executionPoolFixture(database, store, ownedFactoryboxProfile, images);
    const [slot] = await database.client.begin((sql) => store.plan(sql));
    if (!slot) throw new Error("Owned reserve slot missing");
    await store.observe(database.client, slot.id, {
      namespaceUID: "namespace",
      podUID: "pod",
      claimUID: "claim",
      ready: false,
      factoryboxIdentity: { epoch: "owned" },
      factoryboxPreparation: { bundle: "owned-private-input" },
    });
    await store.intendSourceImport(database.client, slot.id, "d".repeat(64));
    await store.completeSourceImport(database.client, slot.id, { sha256: "d".repeat(64) });
    expect(await store.intendStart(database.client, slot.id)).toBe(true);
    for (let index = 0; index < 2; index++) {
      await database.client`UPDATE factory.execution_slot SET reconcile_after=now() WHERE id=${slot.id}`;
      await controller.reconcile();
    }
    expect(admissions).toEqual([false, false]);
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(await store.get(database.client, slot.id)).toMatchObject({
      state: "creating",
      factoryboxStartAttempted: true,
      factoryboxDeleteAttempted: false,
    });
  } finally {
    await controller.close();
    diagnostic.mockRestore();
    await owned?.cleanup();
    await database.client.end({ timeout: 2 });
    await host.dispose();
    restoreConfiguration();
  }
}, 30_000);
