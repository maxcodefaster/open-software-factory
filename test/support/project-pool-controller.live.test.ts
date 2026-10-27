import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRuntimeEnvironmentEndpoint } from "../../apps/factory/src/environments/runtime";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { freezeStagingConfiguration } from "../../apps/factory/src/runtime/staging-configuration";
import { hashConnectorToken } from "../../packages/runtime-domain/src/identity";
import {
  defaultReservePolicy,
  type ExecutionSlot,
} from "../../packages/runtime-domain/src/reserve";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { withCommandDeadline } from "../../packages/runtime-kubernetes/src/command";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  factoryboxWorkerIdentity,
  runFactoryboxKubernetes,
} from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { renderRuntimeResources } from "../../packages/runtime-kubernetes/src/manifest";
import {
  createReserveClient,
  factoryboxReserveInput,
  type ReserveClient,
} from "../../packages/runtime-kubernetes/src/reserve";
import { parseSystemContract } from "../../packages/system-contract/src/system-contract";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { factoryProcess } from "../fixtures/factory-process";
import { removeOwnedFactoryboxFixture } from "../fixtures/factorybox-cleanup";
import { factoryboxFixtureCommand } from "../fixtures/factorybox-runtime";
import { ownedPostgresServer } from "../fixtures/postgres-server";

test.skipIf(process.env["FACTORY_RUN_PROJECT_POOL_CONTROLLER_PROOF"] !== "1")(
  "Factory's persisted controller creates, assigns and refills real paused Project Forks",
  async () => {
    const owner = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/project-pool-controller", owner);
    await mkdir(artifacts, { recursive: true });
    const runtimeImage =
      process.env["FACTORY_RUNTIME_HOST_IMAGE"] ??
      (await readFile(".factory/runtime-host-image", "utf8")).trim();
    const images = { staging: runtimeImage, verification: runtimeImage };
    const profile = configuredFactoryboxRuntimeProfile();
    const postgres = await ownedPostgresServer();
    const previousPostgres = process.env["FACTORY_TEST_POSTGRES"];
    let host: Awaited<ReturnType<typeof factoryProcess>>;
    try {
      process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
      host = await factoryProcess();
    } catch (cause) {
      await postgres.dispose();
      throw cause;
    } finally {
      if (previousPostgres === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
      else process.env["FACTORY_TEST_POSTGRES"] = previousPostgres;
    }
    const database = host.connect();
    const policy = { ...defaultReservePolicy, retryMS: 1000 };
    const store = createReserveStore(policy, images, profile);
    const owned = await executionPoolFixture(database, store, profile, images).catch(
      async (cause) => {
        await database.client.end({ timeout: 2 });
        await host.dispose();
        await postgres.dispose();
        throw cause;
      },
    );
    const hub = new RuntimeHub(async () => {});
    const execution = createFactoryboxExecution(database, hub);
    const environment = createRuntimeEnvironmentEndpoint(database, {
      configured: true,
      read: async () => undefined,
      create: async () => {
        throw new Error("Owned pool proof cannot create secrets");
      },
    });
    const connections: string[] = [];
    const server = Bun.serve<RuntimeSocketData>({
      hostname: "0.0.0.0",
      port: 0,
      fetch(request, server) {
        const path = new URL(request.url).pathname;
        const environmentID = path.match(/^\/internal\/runtime-environment\/([a-f0-9-]{36})$/)?.[1];
        if (environmentID) return environment(request, environmentID);
        const data = hub.authorize(request, hashConnectorToken);
        if (!data) return new Response(null, { status: 401 });
        if (
          server.upgrade(request, {
            data,
            headers: { "sec-websocket-protocol": "factory-runtime-connector-v1" },
          })
        )
          return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          if (socket.data.kind !== "connector") throw new Error("Unexpected browser authority");
          connections.push(socket.data.attemptID);
          hub.open(socket);
        },
        message: (socket, message) => hub.message(socket, message),
        close: (socket) => hub.close(socket),
      },
    });
    const client = createReserveClient();
    const captures: Array<{ slotID: string; template: boolean; nonce: string; pid: number }> = [];
    let containerID = "";
    async function sample(slot: ExecutionSlot) {
      const target = {
        input: factoryboxReserveInput(slot),
        identity: factoryboxWorkerIdentity.parse(slot.factoryboxIdentity),
      };
      if (!containerID)
        containerID = (
          await factoryboxFixtureCommand(target, [
            "docker",
            "ps",
            "-q",
            "--no-trunc",
            "--filter",
            `label=factory.dev/runtime-attempt=${slot.templateID ?? slot.id}`,
          ])
        ).trim();
      expect(containerID).toMatch(/^[a-f0-9]{64}$/);
      return JSON.parse(
        await factoryboxFixtureCommand(target, [
          "docker",
          "exec",
          containerID,
          "node",
          "-e",
          'const r=require("node:http").get({host:"127.0.0.1",port:19472,path:"/",agent:false,headers:{connection:"close"}},res=>res.pipe(process.stdout));r.setTimeout(5000,()=>r.destroy());r.on("error",()=>process.exit(1));',
        ]),
      ) as { nonce: string; pid: number; counter: number };
    }
    const adapter: ReserveClient = {
      ...client,
      prepare: (slot, options) =>
        client.prepare(
          slot,
          options
            ? {
                ...options,
                async intendStandby(action) {
                  if (action === "pause") {
                    const value = await sample(slot);
                    expect(connections.filter((id) => id !== targetAttempt)).toEqual([]);
                    captures.push({
                      slotID: slot.id,
                      template: !slot.templateID,
                      nonce: value.nonce,
                      pid: value.pid,
                    });
                  }
                  return options.intendStandby(action);
                },
              }
            : undefined,
        ),
    };
    let manager = createExecutionReserve(database, images, policy, adapter);
    let targetAttempt = "";
    let passed = false;
    const deadline = performance.now() + 420_000;
    const save = (name: string, value: unknown) =>
      writeFile(resolve(artifacts, name), JSON.stringify(value, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    async function slots() {
      const ids = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.execution_slot ORDER BY created_at,id`;
      const rows = await Promise.all(ids.map((row) => store.get(database.client, row.id)));
      return rows.filter((row): row is ExecutionSlot => row !== null);
    }
    async function until<T>(
      read: () => Promise<T>,
      accept: (value: T) => boolean,
      message: string,
    ) {
      for (;;) {
        if (performance.now() >= deadline) throw new Error(message);
        const value = await read();
        if (accept(value)) return value;
        await manager.reconcile();
        await Bun.sleep(50);
      }
    }
    try {
      await save("intent.json", {
        owner,
        factoryID: host.id,
        projectID: owned.projectID,
        revision: owned.revision,
        runtimeImage,
        profile,
        seededStagingReference: true,
        nativeStagingExecutionProved: false,
      });
      await withCommandDeadline(deadline, async () => {
        const ready = await until(
          slots,
          (rows) => rows.filter((row) => row.templateID && row.state === "ready").length === 2,
          "Project-derived Fork pool never became ready",
        );
        const template = ready.find((row) => !row.templateID);
        const selected = ready.find((row) => row.templateID && row.state === "ready");
        if (!template || !selected) throw new Error("Owned ready pool missing");
        expect(captures).toHaveLength(3);
        expect(new Set(captures.map((value) => value.nonce)).size).toBe(1);
        expect(new Set(captures.map((value) => value.pid)).size).toBe(1);
        targetAttempt = crypto.randomUUID();
        const parentToken = crypto.randomUUID(),
          childToken = crypto.randomUUID();
        await database.client.begin(async (sql) => {
          expect(
            (
              await manager.admit(sql, targetAttempt, "staging", {
                projectID: owned.projectID,
                kind: "staging",
              })
            )?.id,
          ).toBe(selected.id);
          await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
            VALUES(${targetAttempt},${owned.projectID},'staging',2,${owned.revision},'create-intended',${hashConnectorToken(parentToken)},${hashConnectorToken(childToken)},now(),${owned.userID})`;
          await freezeRuntimeArtifacts(sql, targetAttempt, owned.artifactConfiguration);
        });
        hub.allow(
          targetAttempt,
          2,
          hashConnectorToken(parentToken),
          hashConnectorToken(childToken),
        );
        const recipe = template.projectRecipe as {
          channels: unknown;
          processes: unknown;
          devcontainerPath: string;
        };
        const resources = renderRuntimeResources({
          attemptID: targetAttempt,
          workerID: selected.workerID,
          reserveSlotID: selected.id,
          generation: 2,
          projectID: owned.projectID,
          namespace: selected.namespace,
          podName: "worker",
          mode: "staging",
          repositoryURL: `https://unassigned.invalid/${owned.projectID}.git`,
          revision: owned.revision,
          devcontainerPath: recipe.devcontainerPath,
          composeProjectName: `assigned_${targetAttempt.replaceAll("-", "")}`,
          connectorToken: parentToken,
          childConnectorToken: childToken,
          controlURL: `ws://host.orb.internal:${server.port}/internal/runtime-connect`,
          runtimeHostImage: runtimeImage,
          factoryboxProfile: profile,
          environmentVersion: 0,
          registryCA: await readRuntimeRegistryCA(),
          systemContract: parseSystemContract(
            await readFile(`${owned.source}/.factory/system.json`, "utf8"),
          ),
        });
        await freezeStagingConfiguration(database.client, targetAttempt, resources);
        const started = performance.now();
        const activated = await manager.activate(targetAttempt, resources);
        if (!activated) throw new Error("Persisted Fork assignment disappeared");
        await database.client`UPDATE factory.runtime_attempt SET state='starting',
          kubernetes_uid=${activated.podUID},kubernetes_namespace_uid=${activated.namespaceUID},create_observed_at=now()
          WHERE id=${targetAttempt}`;
        await execution.ensureStarted(targetAttempt, resources, deadline);
        await until(
          async () => hub.connected(targetAttempt),
          (value) => value,
          "Assigned Fork never connected",
        );
        await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${targetAttempt}`;
        const usefulMS = Math.round(performance.now() - started);
        const useful = await sample({ ...selected, assignedAttemptID: targetAttempt });
        const baseline = captures[0];
        if (!baseline) throw new Error("Original clean App sample missing");
        expect(useful.nonce).toBe(baseline.nonce);
        expect(useful.pid).toBe(baseline.pid);
        const response = await hub.request(
          targetAttempt,
          "app",
          new Request("http://fixture.invalid/"),
          "/",
        );
        expect(((await response.json()) as { nonce: string }).nonce).toBe(useful.nonce);
        manager.refill();
        await until(
          slots,
          (rows) => rows.filter((row) => row.templateID && row.state === "ready").length === 2,
          "Used Fork was not replaced by a fresh paused Fork",
        );
        await save("controller-pool.json", {
          passed: true,
          usefulMS,
          captures,
          useful,
          slotID: selected.id,
          targetAttempt,
          originalTemplateID: template.id,
          freshConnectorAuthority: true,
          productionPoolControllerProved: true,
          seededStagingReference: true,
          nativeStagingExecutionProved: false,
        });
        await manager.cleanup(targetAttempt, 2);
        await execution.deleteSandbox(targetAttempt, true);
        await manager.removed(database.client, targetAttempt);
        await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${targetAttempt}`;
        hub.revoke(targetAttempt);
        await manager.close();
        manager = createExecutionReserve(database, images, { ...policy, readyTarget: 0 }, adapter);
        await until(
          slots,
          (rows) => rows.every((row) => row.state === "deleted"),
          "Owned pool did not retire all private backing",
        );
        await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.stagingID}`;
        await save("native-workload-complete.json", {
          owner,
          completed: true,
          within420Seconds: performance.now() < deadline,
        });
      });
      passed = true;
    } finally {
      await manager.close();
      if (targetAttempt) hub.revoke(targetAttempt);
      await server.stop(true);
      if (passed) {
        await removeOwnedFactoryboxFixture(host, artifacts);
        await owned.cleanup();
        await database.client.end({ timeout: 2 });
        await host.dispose();
        await postgres.dispose();
      } else {
        const [worker] = await database.client<
          Array<{ id: string; namespaceUID: string | null; podUID: string | null }>
        >`
          SELECT id,namespace_uid AS "namespaceUID",pod_uid AS "podUID" FROM factory.factorybox_worker WHERE singleton`;
        await save("retained-failure.json", {
          owner,
          factoryID: host.id,
          databaseURL: host.databaseURL,
          postgres: postgres.identity,
          worker,
          slots: await slots(),
        });
        if (worker?.podUID && worker.namespaceUID) {
          const namespace = `factory-box-${worker.id.replaceAll("-", "")}`;
          const pod = await runFactoryboxKubernetes([
            "get",
            "pod",
            "worker",
            "-n",
            namespace,
            "-o",
            "json",
          ]);
          if (pod.exitCode === 0 && JSON.parse(pod.stdout).metadata?.uid === worker.podUID) {
            const fenced = await runFactoryboxKubernetes(
              ["delete", "--raw", `/api/v1/namespaces/${namespace}/pods/worker`, "-f", "-"],
              JSON.stringify({
                apiVersion: "v1",
                kind: "DeleteOptions",
                preconditions: { uid: worker.podUID },
                gracePeriodSeconds: 45,
              }),
              { timeoutMS: 60_000, outputBytes: 16 * 1024 },
            );
            await save("fencing.json", fenced);
          }
        }
        await database.client.end({ timeout: 2 });
      }
    }
  },
  600_000,
);
