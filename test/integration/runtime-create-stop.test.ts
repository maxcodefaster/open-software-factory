import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
} from "../../packages/runtime-domain/src/identity";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import {
  createKubernetesClient,
  type KubernetesClient,
} from "../../packages/runtime-kubernetes/src/client";
import upstream from "../../upstream.json";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

// These controller tests inject Kubernetes and never launch these artifacts.
const configuration = {
  FACTORY_RUNTIME_HOST_IMAGE: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  FACTORY_BUILD_RUNTIME_HOST_IMAGE: `example.invalid/owned-build@sha256:${"b".repeat(64)}`,
  FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE: `example.invalid/owned-verification@sha256:${"c".repeat(64)}`,
  FACTORY_BROWSER_TOOLS_IMAGE: `example.invalid/owned-browser@sha256:${"d".repeat(64)}`,
  FACTORY_FORGEJO_API_URL: "http://127.0.0.1:1/api/v1",
  FACTORY_FORGEJO_TOKEN: "owned-mocked-forge-token",
  FACTORY_FORGEJO_OWNER: "owned-runtime-fixture",
};
const previous = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(configuration)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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
                  envboxImage: upstream.envbox.image,
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
        const namespace = `factory-workspace-${workspaceID.replaceAll("-", "").slice(0, 12)}`;
        expected = crypto.randomUUID();
        await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,kubernetes_namespace,volume_name,created_by)
        VALUES(${workspaceID},${owned.projectID},'personal',${owned.userID},'main',${"a".repeat(40)},${namespace},'never-created',${owned.userID})`;
        await database.client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,kubernetes_namespace,kubernetes_pod_name,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${expected},${owned.projectID},${workspaceID},1,${"a".repeat(40)},'ready',${namespace},'never-created',${"a".repeat(64)},${"b".repeat(64)},now(),${owned.userID})`;
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
    await database.client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${owned.attemptID}`;
    const replacement = crypto.randomUUID();
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,kubernetes_namespace,kubernetes_pod_name,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${replacement},project_id,change_id,workspace_id,2,revision,'ready',kubernetes_namespace,'runtime-2',parent_connector_token_hash,child_connector_token_hash,now(),created_by
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
        {
          ...createKubernetesClient(),
          getNamespace: async () => {
            if (failObservation) throw new Error("Owned transient observation failure");
            return { uid: "owned-source-namespace", labels: {} };
          },
          getPod: async (_namespace, podName) => {
            expect(podName).toBe("never-created");
            return null;
          },
          deleteNamespace: async () => {
            deletions++;
          },
          deletePod: async () => {
            deletions++;
          },
        },
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
      {
        ...createKubernetesClient(),
        getNamespace: async () => ({ uid: "owned-source-namespace", labels: {} }),
        getPod: async () => null,
        deleteNamespace: async () => {
          namespaceDeletes++;
        },
      },
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
  "observer replacement",
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
    let deleted = false;
    let applies = 0;
    let podUID = "owned-pod-uid";
    let secretReads = 0;
    let activations = 0;
    const reserved = boundary.startsWith("reserved");
    const beforeCreate = boundary === "before create" || boundary === "reserved before activation";
    const recoveredCreate =
      boundary === "recovered create" || boundary === "reserved recovered create";
    let reserve: ReturnType<typeof createExecutionReserve> | undefined;
    let manifest: Array<{
      kind: string;
      metadata: { labels: Record<string, string> };
      stringData?: Record<string, string>;
    }> = [];
    const hub = new RuntimeHub(async () => {});
    const kubernetes: KubernetesClient = {
      apply: async (resources) => {
        applies += 1;
        manifest = resources as typeof manifest;
        if (boundary === "observer replacement" && applies === 1) {
          exists = true;
          return { namespaceUID: "owned-namespace-uid" };
        }
        entered.resolve();
        await release.promise;
        exists = true;
        if (boundary === "observer replacement") podUID = "owned-replacement-pod-uid";
        return { namespaceUID: "owned-namespace-uid" };
      },
      getPod: async () =>
        exists
          ? {
              uid: podUID,
              phase: boundary === "observer replacement" && applies === 1 ? "Failed" : "Pending",
              labels: manifest.find((resource) => resource.kind === "Pod")?.metadata.labels ?? {},
              envboxImage: upstream.envbox.image,
              runtimeHostImage:
                globalThis.process.env["FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE"] ??
                "missing-test-image",
            }
          : null,
      getNamespace: async () => {
        cleanupObserved.resolve();
        return exists
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
      deletePod: async () => {
        if (boundary !== "observer replacement") throw new Error("Unexpected Pod replacement");
        exists = false;
      },
      deleteNamespace: async (input) => {
        expect(input.namespaceUID).toBe("owned-namespace-uid");
        expect(input.uid).toBe(podUID);
        exists = false;
        deleted = true;
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
        const verificationImage = globalThis.process.env["FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE"];
        const stagingImage = globalThis.process.env["FACTORY_RUNTIME_HOST_IMAGE"];
        if (!verificationImage || !stagingImage) throw new Error("Pinned test images required");
        const images = { staging: stagingImage, verification: verificationImage };
        const store = createReserveStore(
          { ...defaultReservePolicy, creationConcurrency: 2 },
          images,
        );
        const planned = await database.client.begin((sql) => store.plan(sql));
        const slot = planned.find((candidate) => candidate.role === "verification");
        if (!slot) throw new Error("Owned Verification slot missing");
        await store.observe(database.client, slot.id, {
          namespaceUID: "owned-namespace-uid",
          podUID,
          claimUID: "owned-claim",
          ready: true,
        });
        exists = true;
        reserve = createExecutionReserve(
          database,
          images,
          { ...defaultReservePolicy, readyPerRole: 0 },
          {
            async prepare() {
              throw new Error("Unexpected reserve refill");
            },
            async retire() {},
            async activate(assigned, resources) {
              activations++;
              if (!attemptID) throw new Error("Owned runtime intent missing");
              expect(assigned.assignedAttemptID).toBe(attemptID);
              manifest = resources as typeof manifest;
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
              exists = false;
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
          // Initial create returns before its background observer reaches a
          // replacement. Success here is not failure to reach that boundary.
          if (boundary === "observer replacement") return entered.promise;
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
      expect(exists).toBe(false);
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
      expect(applies).toBe(
        reserved || beforeCreate ? 0 : boundary === "observer replacement" ? 2 : 1,
      );
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
      // Let the observer released by the stopped replacement boundary finish
      // its final state read before disposing its database.
      await Bun.sleep(0);
      await database.client.end({ timeout: 2 });
      await process.dispose();
    }
  },
  30_000,
);
