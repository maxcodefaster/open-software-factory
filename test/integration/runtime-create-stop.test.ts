import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import {
  factoryboxAllocation,
  rememberFactoryboxSource,
} from "../../apps/factory/src/runtime/worker";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
} from "../../packages/runtime-domain/src/identity";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import {
  createKubernetesClient,
  type KubernetesClient,
  KubernetesObservationUnavailableError,
} from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import {
  ownedRuntimeConfiguration as configuration,
  installOwnedRuntimeConfiguration,
  ownedFactoryboxProfile,
} from "../fixtures/runtime-configuration";

let restoreConfiguration: () => void;
beforeAll(() => {
  restoreConfiguration = installOwnedRuntimeConfiguration();
});
afterAll(() => {
  restoreConfiguration();
});

const resource = z
  .object({
    kind: z.string(),
    metadata: z
      .object({
        name: z.string(),
        labels: z.record(z.string(), z.string()),
      })
      .passthrough(),
    stringData: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
type Resource = z.infer<typeof resource>;
function mergeResources(current: readonly Resource[], incoming: readonly unknown[]) {
  const values = new Map(current.map((item) => [`${item.kind}/${item.metadata.name}`, item]));
  for (const item of incoming.map((item) => resource.parse(item)))
    values.set(`${item.kind}/${item.metadata.name}`, item);
  return [...values.values()];
}
function acknowledge(resources: readonly unknown[], namespaceUID: string, podUID: string) {
  return {
    namespaceUID,
    sharedUIDs: Object.fromEntries(
      resources
        .map((item) => resource.parse(item))
        .filter(
          (item) =>
            item.kind !== "Namespace" &&
            item.metadata.labels["factory.dev/shared-resource"] === "true",
        )
        .map((item) => [
          `${item.kind}/${item.metadata.name}`,
          item.kind === "Pod"
            ? podUID
            : item.kind === "PersistentVolumeClaim"
              ? item.metadata.name === "runtime-data"
                ? "owned-source-claim"
                : "owned-claim"
              : "owned-registry-ca",
        ]),
    ),
  };
}
async function sourceOnly(sql: Parameters<typeof factoryboxAllocation>[0], namespaceUID: string) {
  const worker = await factoryboxAllocation(sql);
  await rememberFactoryboxSource(sql, worker.id, {
    namespaceUID,
    claimUID: "owned-source-claim",
    storageNode: configuration.FACTORY_FACTORYBOX_NODE,
  });
}

test.each(["reconnect", "Stop"] as const)(
  "startup observation timeout preserves live compute until %s without replaying creates",
  async (outcome) => {
    const host = await factoryProcess();
    const database = host.connect();
    const unavailable = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    let faultObserved = false;
    let creates = 0;
    let deletions = 0;
    let exists = false;
    let namespaceCreated = false;
    let manifest: Resource[] = [];
    const failedRead = createKubernetesClient(async () => ({
      stdout: "",
      stderr:
        "Unable to connect to the server: context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
      exitCode: 1,
    }));
    let controller: ReturnType<typeof createRuntimeController> | undefined;
    let attemptID: string | undefined;
    try {
      const owned = await fixture(undefined, undefined, database);
      controller = createRuntimeController(
        database,
        new RuntimeHub(async () => {}),
        "owned-startup-observation-secret",
        {
          prepareExecution: async () => {
            throw new Error("Verification must not prepare development source");
          },
        },
        {
          ...createKubernetesClient(),
          apply: async (resources) => {
            if (resources.some((item) => resource.parse(item).kind === "Pod")) {
              creates++;
              exists = true;
            }
            namespaceCreated = true;
            manifest = mergeResources(manifest, resources);
            return acknowledge(resources, "owned-observation-namespace", "owned-observation-pod");
          },
          getNamespace: async () =>
            namespaceCreated
              ? {
                  uid: "owned-observation-namespace",
                  labels: manifest.find((item) => item.kind === "Namespace")?.metadata.labels ?? {},
                }
              : null,
          getPod: async (namespace, podName) => {
            if (!exists) return null;
            reads++;
            const [current] = await database.client<Array<{ observed: boolean }>>`
              SELECT EXISTS(SELECT 1 FROM factory.runtime_attempt
                WHERE kubernetes_namespace=${namespace} AND kubernetes_pod_name=${podName}
                  AND isolated_kind='verification' AND state='starting'
                  AND create_observed_at IS NOT NULL) AS observed`;
            if (!faultObserved && current?.observed) {
              faultObserved = true;
              unavailable.resolve();
              await release.promise;
              return failedRead.getPod(namespace, podName);
            }
            return exists
              ? {
                  uid: "owned-observation-pod",
                  phase: "Running",
                  labels:
                    manifest.find((resource) => resource.kind === "Pod")?.metadata.labels ?? {},
                  factoryboxImage: configuration.FACTORY_FACTORYBOX_WORKER_IMAGE,
                  runtimeHostImage: configuration.FACTORY_RUNTIME_HOST_IMAGE,
                }
              : null;
          },
          deleteNamespace: async () => {
            deletions++;
            throw new Error("Stop must preserve the shared Factory Namespace");
          },
          deletePod: async () => {
            throw new Error("Unavailable observation must not replace a Pod");
          },
          deleteSecret: async () => {},
        },
        async () => "",
      );
      const verificationID = crypto.randomUUID();
      await database.client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,
        runner_name,runner_uuid,runner_token,action_run_id,created_by)
        VALUES(${verificationID},${owned.changeID},${"d".repeat(40)},1,'owned-observation',
          ${crypto.randomUUID()},'owned-observation-token',1,${owned.userID})`;
      const attempt = await controller.startVerification(verificationID, owned.userID);
      if (!attempt) throw new Error("Owned runtime intent missing");
      attemptID = attempt.id;
      await unavailable.promise;
      if (outcome === "Stop") await controller.stop(attemptID);
      release.resolve();
      if (outcome === "reconnect") {
        await eventually(
          async () => ({
            reads,
            state: (await controller?.get(attemptID ?? ""))?.state,
          }),
          (value) => value.reads >= 3 || value.state !== "starting",
          "Startup observation did not settle",
        );
        const retained = await controller.get(attemptID);
        expect(retained?.state).toBe("starting");
        expect(deletions).toBe(0);
        await controller.status(attemptID, "ready");
        expect((await controller.get(attemptID))?.state).toBe("ready");
      } else {
        await eventually(
          async () => (await controller?.get(attemptID ?? ""))?.state,
          (state) => state === "stopped",
          "Stop did not settle during unavailable observation",
        );
      }
      expect(creates).toBe(1);
      expect(
        (
          await database.client`SELECT kubernetes_uid FROM factory.runtime_attempt WHERE id=${attemptID}`
        )[0]?.["kubernetes_uid"],
      ).toBe("owned-observation-pod");
    } finally {
      release.resolve();
      try {
        if (attemptID && controller) {
          if ((await controller.get(attemptID))?.state === "stopping")
            await eventually(
              async () => (await controller?.get(attemptID ?? ""))?.state,
              (state) => state === "failed" || state === "stopped",
              "Failed observer cleanup did not settle",
            );
          await controller.stop(attemptID);
          await eventually(
            async () => (await controller?.get(attemptID ?? ""))?.state,
            (state) => state === "stopped",
            "Owned observer fixture cleanup did not settle",
          );
          // The startup loop reads its persisted Stop on its one-second cadence.
          // Keep the owned database alive until that final read can finish.
          await Bun.sleep(1_500);
        }
      } finally {
        await database.client.end({ timeout: 2 });
        await host.dispose();
      }
    }
  },
  30_000,
);

test.each(["live", "observation unavailable", "reconnected during observation"] as const)(
  "connector reconnect delay preserves a %s Sandbox and its capabilities",
  async (scenario) => {
    const process = await factoryProcess();
    const database = process.connect();
    const token = "owned-reconnect-capability";
    const owned = await fixture(undefined, undefined, database, token);
    const hub = new RuntimeHub(async () => {});
    let present = true;
    let deletions = 0;
    const observation = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    try {
      await database.client`UPDATE factory.runtime_attempt SET kubernetes_uid='owned-live-pod',
      kubernetes_namespace_uid='owned-live-namespace' WHERE id=${owned.attemptID}`;
      hub.allow(owned.attemptID, 1, hashConnectorToken(token), hashConnectorToken(token));
      const controller = createRuntimeController(
        database,
        hub,
        "owned-reconnect-secret",
        {
          prepareExecution: async () => {
            throw new Error("Connection recovery must not prepare another checkout");
          },
        },
        {
          ...createKubernetesClient(),
          getNamespace: async () => ({ uid: "owned-live-namespace", labels: {} }),
          getPod: async () => {
            if (scenario === "observation unavailable")
              throw new Error("Owned observation timeout");
            if (scenario === "reconnected during observation") {
              observed.resolve();
              await observation.promise;
            }
            return present
              ? {
                  uid: "owned-live-pod",
                  phase: "Running",
                  labels: {},
                  factoryboxImage: configuration.FACTORY_FACTORYBOX_WORKER_IMAGE,
                  runtimeHostImage: "owned-image-not-used-by-observation",
                }
              : null;
          },
          deletePod: async () => {
            deletions++;
            present = false;
          },
          deleteNamespace: async () => {
            deletions++;
            present = false;
          },
        },
        async () => "",
      );
      const disconnected = controller.status(
        owned.attemptID,
        "disconnected",
        "Owned connector is reconnecting",
      );
      if (scenario === "reconnected during observation") {
        await observed.promise;
        await controller.status(owned.attemptID, "ready");
        observation.resolve();
      }
      await disconnected;
      const [waiting] =
        await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(waiting?.["state"]).toBe(
        scenario === "reconnected during observation" ? "ready" : "starting",
      );
      expect(deletions).toBe(0);
      expect(
        hub.authorize(
          new Request("http://factory.local/internal/connectors", {
            headers: {
              authorization: `Bearer ${token}`,
              "x-factory-connector-role": "child",
              "x-factory-runtime-attempt": owned.attemptID,
              "x-factory-runtime-generation": "1",
            },
          }),
          hashConnectorToken,
        ),
      ).not.toBeNull();
      await controller.status(owned.attemptID, "ready");
      const [recovered] =
        await database.client`SELECT state,kubernetes_uid FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(recovered).toMatchObject({ state: "ready", kubernetes_uid: "owned-live-pod" });
      expect(deletions).toBe(0);
    } finally {
      await database.client.end({ timeout: 1 });
      await process.dispose();
    }
  },
  30_000,
);

test.each(["exited", "native-read-unavailable", "reconnected-during-native-read"] as const)(
  "shared worker reconnect observes its original native Sandbox: %s",
  async (scenario) => {
    const processFixture = await factoryProcess();
    const database = processFixture.connect();
    const token = "owned-native-reconnect-capability";
    const owned = await fixture(undefined, undefined, database, token);
    const hub = new RuntimeHub(async () => {});
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let nativeReads = 0;
    let nativeDeletes = 0;
    let workerDeletes = 0;
    try {
      await database.client`UPDATE factory.runtime_attempt SET kubernetes_uid='owned-native-pod',
        kubernetes_namespace_uid='owned-native-namespace',
        updated_at='2026-10-29T10:00:00.123456Z'::timestamptz WHERE id=${owned.attemptID}`;
      hub.allow(owned.attemptID, 1, hashConnectorToken(token), hashConnectorToken(token));
      const execution = {
        ...createFactoryboxExecution(database, hub),
        async hasExited(attemptID: string) {
          expect(attemptID).toBe(owned.attemptID);
          nativeReads++;
          if (scenario === "native-read-unavailable")
            throw new Error("Owned native read unavailable");
          if (scenario === "reconnected-during-native-read") {
            observed.resolve();
            await release.promise;
          }
          return true;
        },
        async deleteSandbox(attemptID: string) {
          expect(attemptID).toBe(owned.attemptID);
          nativeDeletes++;
        },
      };
      const controller = createRuntimeController(
        database,
        hub,
        "owned-native-reconnect-secret",
        {
          prepareExecution: async () => {
            throw new Error("Observation cannot prepare source");
          },
        },
        {
          ...createKubernetesClient(),
          getNamespace: async () => ({ uid: "owned-native-namespace", labels: {} }),
          getPod: async () => ({
            uid: "owned-native-pod",
            phase: "Running",
            labels: {},
            factoryboxImage: configuration.FACTORY_FACTORYBOX_WORKER_IMAGE,
            runtimeHostImage: "owned-native-image-not-used-by-observation",
          }),
          deleteSecret: async () => {},
          deletePod: async () => {
            workerDeletes++;
          },
          deleteNamespace: async () => {
            workerDeletes++;
          },
        },
        async () => "",
        undefined,
        execution,
      );
      const checking = controller.status(owned.attemptID, "disconnected");
      if (scenario === "reconnected-during-native-read") {
        await observed.promise;
        await controller.status(owned.attemptID, "ready");
        release.resolve();
      }
      await checking;
      expect(nativeReads).toBe(1);
      if (scenario === "exited")
        await eventually(
          () => controller.get(owned.attemptID),
          (value) => value?.state === "failed",
          "A stopped Sandbox remained reconnecting behind its live worker",
        ).catch(async () => {
          const current = await controller.get(owned.attemptID);
          throw new Error(
            `Native exit did not settle: ${current?.state}; ${current?.failure}; native cleanup calls=${nativeDeletes}`,
          );
        });
      const current = await controller.get(owned.attemptID);
      expect(current?.state).toBe(
        scenario === "exited"
          ? "failed"
          : scenario === "native-read-unavailable"
            ? "starting"
            : "ready",
      );
      if (scenario === "exited") expect(current?.failure).toContain("Sandbox exited");
      expect(nativeDeletes).toBe(scenario === "exited" ? 1 : 0);
      expect(workerDeletes).toBe(0);
      const authorization = hub.authorize(
        new Request("http://factory.local/internal/connectors", {
          headers: {
            authorization: `Bearer ${token}`,
            "x-factory-connector-role": "child",
            "x-factory-runtime-attempt": owned.attemptID,
            "x-factory-runtime-generation": "1",
          },
        }),
        hashConnectorToken,
      );
      expect(authorization !== null).toBe(scenario !== "exited");
      if (scenario !== "exited") await controller.status(owned.attemptID, "ready");
    } finally {
      release.resolve();
      await database.client.end({ timeout: 1 });
      await processFixture.dispose();
    }
  },
  60_000,
);

test.each(["personal", "staging", "ticket"] as const)(
  "retained %s runtime reads do not deadlock a one-connection application pool",
  async (kind) => {
    const isolated = await factoryProcess();
    const database = isolated.connect(1);
    let pending: Promise<unknown> | undefined;
    try {
      const owned = await fixture(undefined, undefined, database);
      const controller = createRuntimeController(
        database,
        new RuntimeHub(async () => {}),
        "owned-pool-secret",
        {
          async prepareExecution() {
            throw new Error("Retained runtime must not prepare source");
          },
        },
        {
          ...createKubernetesClient(),
          async apply() {
            throw new Error("Retained runtime must not create resources");
          },
        },
        async () => "",
      );
      let expected = owned.attemptID;
      if (kind === "personal") {
        const workspaceID = crypto.randomUUID();
        expected = crypto.randomUUID();
        await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
        VALUES(${workspaceID},${owned.projectID},'personal',${owned.userID},'main',${"a".repeat(40)},${owned.userID})`;
        await database.client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${expected},${owned.projectID},${workspaceID},1,${"a".repeat(40)},'ready',${"a".repeat(64)},${"b".repeat(64)},now(),${owned.userID})`;
        pending = controller.start(owned.projectID, owned.userID);
      } else if (kind === "staging") {
        await database.client`INSERT INTO factory.staging_preview(project_id,revision,runtime_attempt_id) VALUES(${owned.projectID},${"a".repeat(40)},${owned.attemptID})`;
        pending = controller.ensureStaging(owned.projectID, owned.userID);
      } else {
        await database.client`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
        SELECT ${crypto.randomUUID()},id,'owned','pool',branch_name,base_sha,${crypto.randomUUID()},'succeeded',base_sha,now() FROM factory.change WHERE id=${owned.changeID}`;
        pending = controller.startPersisted(owned.changeID, owned.userID);
      }
      void pending.catch(() => {});
      const current = await Promise.race([
        pending,
        Bun.sleep(1000).then(() => {
          throw new Error("Retained runtime read deadlocked the application pool");
        }),
      ]);
      expect(current).toMatchObject({ id: expected, state: "ready" });
    } finally {
      await database.client.end({ timeout: 1 });
      await pending?.catch(() => {});
      await isolated.dispose();
    }
  },
  30_000,
);

test("Stop retires a failed older attempt without reactivating it or stopping its replacement", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    await sourceOnly(database.client, "owned-source-namespace");
    await database.client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${owned.attemptID}`;
    const replacement = crypto.randomUUID();
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${replacement},project_id,change_id,workspace_id,2,revision,'ready',parent_connector_token_hash,child_connector_token_hash,now(),created_by
      FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    let failObservation = true;
    let deletions = 0;
    const controller = () =>
      createRuntimeController(
        database,
        new RuntimeHub(async () => {}),
        "owned-stale-stop-key",
        {
          prepareExecution: async () => {
            throw new Error("Stop must not prepare source");
          },
        },
        createKubernetesClient(async (args) => {
          if (args[0] !== "get") {
            deletions++;
            throw new Error("Stop must not remove the shared worker");
          }
          if (args[1] === "namespace") {
            if (failObservation) throw new Error("Owned transient observation failure");
            return {
              stdout: JSON.stringify({ metadata: { uid: "owned-source-namespace" } }),
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: "",
            stderr: "Error from server (NotFound): assignment never created",
            exitCode: 1,
          };
        }),
        async () => "",
      );
    await expect(controller().stop(owned.attemptID)).rejects.toThrow(
      "Owned transient observation failure",
    );
    const [intent] = await database.client<
      { state: string; intended: boolean }[]
    >`SELECT state,stop_intended_at IS NOT NULL AS intended FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    expect(intent).toEqual({ state: "failed", intended: true });
    failObservation = false;
    await controller().stop(owned.attemptID);
    await controller().stop(owned.attemptID);
    const states = await database.client<
      { id: string; state: string }[]
    >`SELECT id,state FROM factory.runtime_attempt WHERE project_id=${owned.projectID} ORDER BY generation`;
    expect([...states]).toEqual([
      { id: owned.attemptID, state: "stopped" },
      { id: replacement, state: "ready" },
    ]);
    expect(deletions).toBe(0);
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);

test("a transient namespace read during failed-attempt Stop settles without another human retry", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const release = Promise.withResolvers<void>();
  let attemptID: string | undefined;
  let controller: ReturnType<typeof createRuntimeController> | undefined;
  let reads = 0;
  let deletions = 0;
  try {
    const owned = await fixture(undefined, undefined, database);
    attemptID = owned.attemptID;
    await sourceOnly(database.client, "owned-source-namespace");
    await database.client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${attemptID}`;
    const replacement = crypto.randomUUID();
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${replacement},project_id,change_id,workspace_id,2,revision,'ready',parent_connector_token_hash,child_connector_token_hash,now(),created_by
      FROM factory.runtime_attempt WHERE id=${attemptID}`;
    controller = createRuntimeController(
      database,
      new RuntimeHub(async () => {}),
      "owned-transient-stop-secret",
      {
        prepareExecution: async () => {
          throw new Error("Stop must not prepare source or repeat work");
        },
      },
      createKubernetesClient(async (args) => {
        if (args[0] !== "get") {
          deletions++;
          throw new Error("Stop must not remove the shared worker");
        }
        if (args[1] === "namespace") {
          if (++reads === 1)
            throw new KubernetesObservationUnavailableError("Owned namespace read timed out");
          await release.promise;
          return {
            stdout: JSON.stringify({ metadata: { uid: "owned-source-namespace" } }),
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "Error from server (NotFound): assignment never created",
          exitCode: 1,
        };
      }),
      async () => "",
    );
    await controller.stop(attemptID);
    const [pending] = await database.client`
      SELECT state,stop_intended_at IS NOT NULL AS intended FROM factory.runtime_attempt WHERE id=${attemptID}`;
    expect(pending).toEqual({ state: "failed", intended: true });
    release.resolve();
    await eventually(
      async () => (await controller?.get(owned.attemptID))?.state,
      (state) => state === "stopped",
      "Persisted Stop was not reconciled after the transient read",
    );
    expect((await controller.get(replacement))?.state).toBe("ready");
    expect(deletions).toBe(0);
    expect(reads).toBe(2);
  } finally {
    release.resolve();
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

test("Factory restart does not revive explicitly stopped Main-Previews", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  let creates = 0;
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.staging_preview(project_id,revision,runtime_attempt_id) VALUES(${owned.projectID},${"a".repeat(40)},${owned.attemptID})`;
    await database.client`UPDATE factory.runtime_attempt SET state='stopped',stop_intended_at=now() WHERE id=${owned.attemptID}`;
    const controller = createRuntimeController(
      database,
      new RuntimeHub(async () => {}),
      "owned-stopped-preview-key",
      {
        prepareExecution: async () => {
          throw new Error("Stopped Preview must not prepare source");
        },
      },
      {
        ...createKubernetesClient(),
        apply: async () => {
          creates++;
          throw new Error("Stopped Preview must remain stopped");
        },
      },
      async () => "",
    );
    const observe = await controller.recover();
    observe();
    await Bun.sleep(1_150);
    expect(creates).toBe(0);
    expect(
      (
        await database.client<
          { state: string }[]
        >`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`
      )[0]?.state,
    ).toBe("stopped");
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);

test("cancelling Ticket compute before create retains its independently owned source Namespace", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    await sourceOnly(database.client, "owned-source-namespace");
    await database.client`UPDATE factory.change SET cancel_requested_at=now() WHERE id=${owned.changeID}`;
    let namespaceDeletes = 0;
    const controller = createRuntimeController(
      database,
      new RuntimeHub(async () => {}),
      "owned-connector-secret",
      {
        prepareExecution: async () => {
          throw new Error("Stop must not prepare source");
        },
      },
      createKubernetesClient(async (args) => {
        if (args[0] !== "get") {
          namespaceDeletes++;
          throw new Error("Compute Stop must not delete canonical Source");
        }
        return args[1] === "namespace"
          ? {
              stdout: JSON.stringify({ metadata: { uid: "owned-source-namespace" } }),
              stderr: "",
              exitCode: 0,
            }
          : {
              stdout: "",
              stderr: "Error from server (NotFound): compute never created",
              exitCode: 1,
            };
      }),
      async () => "owned-ca",
    );
    await controller.stop(owned.attemptID);
    const attempt = await eventually(
      async () => {
        const [current] = await database.client<Array<{ state: string }>>`
          SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
        return current;
      },
      (current) => current?.state === "stopped",
      "Owned compute cleanup did not complete",
    );
    expect(attempt?.state).toBe("stopped");
    expect(namespaceDeletes).toBe(0);
    expect(
      await database.client`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`,
    ).toHaveLength(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);

test.each(["stop", "cancel", "failure"] as const)(
  "%s cleanup preserves the correct Change outcome across Factory recovery",
  async (action) => {
    const host = await factoryProcess();
    const database = host.connect();
    try {
      const work = await fixture(undefined, undefined, database);
      const controller = createRuntimeController(
        database,
        new RuntimeHub(async () => {}),
        "owned-cleanup-outcome-secret",
        {
          prepareExecution: async () => {
            throw new Error("Cleanup must not prepare source");
          },
        },
        { ...createKubernetesClient(), getNamespace: async () => null, getPod: async () => null },
        async () => "",
      );
      if (action === "cancel")
        await database.client`UPDATE factory.change SET cancel_requested_at=now() WHERE id=${work.changeID}`;
      if (action === "failure")
        await controller.status(work.attemptID, "failed", "Owned runtime failure");
      else await controller.stop(work.attemptID);
      await eventually(
        async () =>
          (
            await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${work.attemptID}`
          )[0]?.["state"],
        (state) => state === (action === "failure" ? "failed" : "stopped"),
        "Cleanup did not settle",
      );
      const expected = action === "stop" ? "active" : action === "cancel" ? "cancelled" : "failed";
      expect(
        (await database.client`SELECT state FROM factory.change WHERE id=${work.changeID}`)[0]?.[
          "state"
        ],
      ).toBe(expected);
      await controller.recover();
      expect(
        (await database.client`SELECT state FROM factory.change WHERE id=${work.changeID}`)[0]?.[
          "state"
        ],
      ).toBe(expected);
    } finally {
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  30_000,
);

test.each([
  "create",
  "recovered create",
  "terminal worker observation",
  "before create",
  "reserved before activation",
  "reserved recovered create",
] as const)(
  "Stop during %s retains exact identities and removes compute without revival",
  async (boundary) => {
    const process = await factoryProcess();
    const database = process.connect();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupObserved = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    let exists = false;
    let namespaceCreated = false;
    let deleted = false;
    let applies = 0;
    let podReads = 0;
    const podUID = "owned-pod-uid";
    let secretReads = 0;
    let activations = 0;
    const reserved = boundary.startsWith("reserved");
    const beforeCreate = boundary === "before create" || boundary === "reserved before activation";
    const recoveredCreate =
      boundary === "recovered create" || boundary === "reserved recovered create";
    let reserve: ReturnType<typeof createExecutionReserve> | undefined;
    let manifest: Resource[] = [];
    const hub = new RuntimeHub(async () => {});
    const kubernetes: KubernetesClient = {
      apply: async (resources) => {
        if (!resources.some((item) => resource.parse(item).kind === "Pod")) {
          namespaceCreated = true;
          manifest = mergeResources(manifest, resources);
          return acknowledge(resources, "owned-namespace-uid", podUID);
        }
        if (exists) {
          manifest = mergeResources(manifest, resources);
          return acknowledge(resources, "owned-namespace-uid", podUID);
        }
        applies += 1;
        manifest = mergeResources(manifest, resources);
        if (boundary === "terminal worker observation") {
          exists = true;
          return acknowledge(resources, "owned-namespace-uid", podUID);
        }
        entered.resolve();
        await release.promise;
        exists = true;
        return acknowledge(resources, "owned-namespace-uid", podUID);
      },
      getPod: async () => {
        if (!exists) return null;
        if (boundary === "terminal worker observation" && ++podReads >= 2) entered.resolve();
        return exists
          ? {
              uid: podUID,
              phase: boundary === "terminal worker observation" ? "Failed" : "Pending",
              labels: manifest.find((resource) => resource.kind === "Pod")?.metadata.labels ?? {},
              factoryboxImage: configuration.FACTORY_FACTORYBOX_WORKER_IMAGE,
              runtimeHostImage:
                globalThis.process.env["FACTORY_RUNTIME_HOST_IMAGE"] ?? "missing-test-image",
            }
          : null;
      },
      getNamespace: async () => {
        cleanupObserved.resolve();
        return namespaceCreated
          ? {
              uid: "owned-namespace-uid",
              labels:
                manifest.find((resource) => resource.kind === "Namespace")?.metadata.labels ?? {},
            }
          : null;
      },
      getPodLogs: async () => "",
      readSecret: async (_namespace, _name, key) => {
        secretReads += 1;
        const value = manifest.find(
          (resource) => resource.kind === "Secret" && resource.stringData?.[key],
        )?.stringData?.[key];
        if (!value) throw new Error("Owned Secret missing");
        return value;
      },
      deleteSecret: async (input) => {
        expect(input.namespaceUID).toBe("owned-namespace-uid");
        manifest = manifest.filter(
          (item) => item.kind !== "Secret" || item.metadata.name !== input.name,
        );
        deleted = true;
      },
      deletePod: async () => {
        throw new Error("Factorybox must never replace the original worker");
      },
      deleteNamespace: async (input) => {
        expect(input.namespaceUID).toBe("owned-namespace-uid");
        expect(input.uid).toBe(podUID);
        throw new Error("A Sandbox Stop must never delete the Factory Namespace");
      },
    };
    const controller = (first = false) =>
      createRuntimeController(
        database,
        hub,
        "owned-runtime-secret",
        {
          async prepareExecution(attemptID) {
            const [attempt] = await database.client<
              Array<{ workspaceID: string }>
            >`SELECT workspace_id AS "workspaceID" FROM factory.runtime_attempt WHERE id=${attemptID}`;
            if (!attempt) throw new Error("Missing admitted execution");
            return {
              workspaceID: attempt.workspaceID,
              namespaceUID: "owned-namespace-uid",
              claimUID: "owned-claim",
              storageNode: "owned-node",
            };
          },
        },
        kubernetes,
        async () => {
          if (first && (beforeCreate || recoveredCreate)) {
            preparing.resolve();
            await prepared.promise;
          }
          return "";
        },
        reserve,
      );
    let creating: Promise<unknown> | undefined;
    let recovering: Promise<unknown> | undefined;
    let attemptID: string | undefined;
    let poolFixture: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
    async function read() {
      const rows = await database.client<
        {
          state: string;
          stopRecorded: boolean;
          podUID: string | null;
          namespaceUID: string | null;
        }[]
      >`
      SELECT state, stop_intended_at IS NOT NULL AS "stopRecorded", kubernetes_uid AS "podUID",
        kubernetes_namespace_uid AS "namespaceUID" FROM factory.runtime_attempt WHERE id = ${attemptID ?? null}`;
      return rows[0];
    }
    function canConnect() {
      if (!attemptID) throw new Error("Owned attempt missing");
      const token = runtimeConnectorTokens("owned-runtime-secret", attemptID, 1).parent;
      return (
        hub.authorize(
          new Request("http://factory.invalid/internal/runtime-connect", {
            headers: {
              authorization: `Bearer ${token}`,
              "x-factory-connector-role": "parent",
              "x-factory-runtime-attempt": attemptID,
              "x-factory-runtime-generation": "1",
            },
          }),
          hashConnectorToken,
        ) !== null
      );
    }
    try {
      const owned = await fixture(undefined, undefined, database);
      if (reserved) {
        const verificationImage = globalThis.process.env["FACTORY_RUNTIME_HOST_IMAGE"];
        const stagingImage = globalThis.process.env["FACTORY_RUNTIME_HOST_IMAGE"];
        if (!verificationImage || !stagingImage) throw new Error("Pinned test images required");
        const images = { staging: stagingImage, verification: verificationImage };
        const store = createReserveStore(
          { ...defaultReservePolicy, creationConcurrency: 2 },
          images,
        );
        poolFixture = await executionPoolFixture(
          database,
          store,
          ownedFactoryboxProfile,
          images,
          owned,
        );
        const template = await poolFixture.prepareTemplate();
        if (!template) throw new Error("Owned template missing");
        const planned = await database.client.begin((sql) => store.plan(sql));
        const slot = planned.find((candidate) => candidate.templateID);
        if (!slot) throw new Error("Owned Verification slot missing");
        await store.observe(database.client, slot.id, {
          namespaceUID: "owned-namespace-uid",
          podUID,
          claimUID: "owned-claim",
          ready: false,
          factoryboxIdentity: { epoch: "owned" },
          factoryboxPreparation: { bundle: "owned" },
        });
        const source = template.factoryboxStandby as {
          sandboxID: string;
          owner: string;
          snapshotID: string;
          checkpointSHA256: string;
        };
        expect(
          await store.intendFork(database.client, slot.id, {
            action: "fork",
            sandboxID: `runtime-${slot.id.replaceAll("-", "")}`,
            sourceSandboxID: source.sandboxID,
            sourceOwner: source.owner,
            snapshotID: source.snapshotID,
            checkpointSHA256: source.checkpointSHA256,
          }),
        ).toBe(true);
        expect(await store.intendStandby(database.client, slot.id, "pause")).toBe(true);
        await store.observe(database.client, slot.id, {
          namespaceUID: "owned-namespace-uid",
          podUID,
          claimUID: "owned-claim",
          ready: true,
          factoryboxPaused: true,
          factoryboxStandby: { ...source, anonymousBytes: 0, snapshotResidentBytes: 0 },
        });
        exists = true;
        namespaceCreated = true;
        reserve = createExecutionReserve(
          database,
          images,
          { ...defaultReservePolicy, readyTarget: 0 },
          {
            async prepare() {
              throw new Error("Unexpected reserve refill");
            },
            async retire() {},
            async activate(assigned, resources) {
              activations++;
              if (!attemptID) throw new Error("Owned runtime intent missing");
              expect(assigned.assignedAttemptID).toBe(attemptID);
              manifest = mergeResources(manifest, resources);
              entered.resolve();
              await release.promise;
              return {
                namespaceUID: "owned-namespace-uid",
                podUID,
                claimUID: "owned-claim",
                ready: true,
                failed: false,
              };
            },
            async removeAssigned(assigned) {
              if (!attemptID) throw new Error("Owned runtime intent missing");
              expect(assigned.podUID).toBe(podUID);
              expect(assigned.assignedAttemptID).toBe(attemptID);
              manifest = manifest.filter(
                (item) =>
                  item.kind !== "Secret" ||
                  item.metadata.labels["factory.dev/runtime-attempt"] !==
                    assigned.assignedAttemptID,
              );
              deleted = true;
              return true;
            },
          },
        );
      }
      const verificationID = crypto.randomUUID();
      if (recoveredCreate) {
        await database.client`UPDATE factory.runtime_attempt SET state = 'stopped' WHERE id = ${owned.attemptID}`;
        // This dummy Build is not the Change's current execution. Recovery must not
        // legitimately fail the Change before reaching the Verification create race.
        await database.client`UPDATE factory.change SET runtime_attempt_id=NULL WHERE id=${owned.changeID}`;
      }
      await database.client`INSERT INTO factory.verification(id, change_id, commit_sha, pull_request_number,
      runner_name, runner_uuid, runner_token, action_run_id, created_by)
      VALUES (${verificationID}, ${owned.changeID}, ${"d".repeat(40)}, 1, 'owned-verification',
        ${crypto.randomUUID()}, 'owned-runner-token', 1, ${owned.userID})`;
      creating = controller(true).startVerification(verificationID, owned.userID);
      // The rejection is checked after releasing the boundary, never left unhandled.
      void creating.catch(() => undefined);
      await Promise.race([
        beforeCreate || recoveredCreate ? preparing.promise : entered.promise,
        creating.then(() => {
          // Initial create returns before the background observer sees the
          // terminal original worker. No replacement is authorized.
          if (boundary === "terminal worker observation") return entered.promise;
          throw new Error("Owned runtime create finished without reaching its test boundary");
        }),
      ]);
      const attempts = await database.client<{ id: string }[]>`
      SELECT id FROM factory.runtime_attempt WHERE verification_id = ${verificationID}`;
      attemptID = attempts[0]?.id;
      if (!attemptID) throw new Error("Owned create intent missing");
      if (recoveredCreate) {
        recovering = controller()
          .recover()
          .then((observe) => {
            if (reserved) {
              expect(activations).toBe(0);
              observe();
            }
          });
        void recovering.catch(() => undefined);
        await entered.promise;
      }
      await controller().stop(attemptID);
      expect((await read())?.stopRecorded).toBe(true);
      expect(canConnect()).toBe(false);
      // Give old cleanup a deterministic opportunity to observe the absent Namespace.
      await Promise.race([cleanupObserved.promise, Bun.sleep(100)]);
      release.resolve();
      prepared.resolve();
      await creating.catch(() => undefined);
      await recovering;
      await eventually(read, (row) => row?.state === "stopped", "Stopped runtime was not settled");
      expect(exists).toBe(reserved || !beforeCreate);
      expect(deleted).toBe(reserved || !beforeCreate);
      expect(await read()).toMatchObject({
        state: "stopped",
        stopRecorded: true,
        podUID: beforeCreate ? null : podUID,
        namespaceUID: beforeCreate ? null : "owned-namespace-uid",
      });
      await controller().status(attemptID, "ready");
      expect((await read())?.state).toBe("stopped");
      expect(canConnect()).toBe(false);
      expect(applies).toBe(reserved || beforeCreate ? 0 : 1);
      expect(
        manifest.some(
          (item) =>
            item.kind === "Secret" &&
            item.metadata.labels["factory.dev/runtime-attempt"] === attemptID,
        ),
      ).toBe(false);
      expect(secretReads).toBe(boundary === "recovered create" ? 3 : 0);
      if (reserved) {
        expect(activations).toBe(beforeCreate ? 0 : 1);
        expect((await reserve?.assigned(database.client, attemptID))?.state).toBe("deleted");
      }
    } finally {
      release.resolve();
      prepared.resolve();
      await creating?.catch(() => undefined);
      await recovering?.catch(() => undefined);
      await reserve?.close();
      await poolFixture?.cleanup();
      // Let the observer released by the stopped replacement boundary finish
      // its final state read before disposing its database.
      await Bun.sleep(0);
      await database.client.end({ timeout: 2 });
      await process.dispose();
    }
  },
  30_000,
);
