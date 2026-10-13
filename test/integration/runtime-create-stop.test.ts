import { expect, test } from "bun:test";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
} from "../../packages/runtime-domain/src/identity";
import {
  createKubernetesClient,
  type KubernetesClient,
} from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import upstream from "../../upstream.json";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";

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
      await (beforeCreate || recoveredCreate ? preparing.promise : entered.promise);
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
      await database.client.end({ timeout: 0 });
      await process.dispose();
    }
  },
  30_000,
);
