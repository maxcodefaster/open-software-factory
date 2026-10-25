import { expect, test } from "bun:test";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import {
  type FactoryboxRuntimeInput,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeRequest,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import type { runFactoryboxKubernetes } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

// Kubernetes and worker transport observations are fixtures. These cases prove
// persisted Factory ownership, not native qualification of either architecture.
test.each(["arm64", "amd64"] as const)(
  "Factorybox %s keeps ownership across Pause/Resume and observes a lost Start response without repeating it",
  async (architecture) => {
    const processFixture = await factoryProcess();
    const database = processFixture.connect();
    try {
      const owned = await fixture(undefined, undefined, database);
      const [attempt] = await database.client<
        Array<{
          namespace: string;
          podName: string;
          workspaceID: string;
          generation: string;
          parent: string;
          child: string;
        }>
      >`
      SELECT kubernetes_namespace AS namespace,kubernetes_pod_name AS "podName",workspace_id AS "workspaceID",generation,
        parent_connector_token_hash AS parent,child_connector_token_hash AS child FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      if (!attempt) throw new Error("Missing owned attempt");
      const profile = {
        image: `registry.invalid/worker@sha256:${"a".repeat(64)}`,
        executableSHA256: "b".repeat(64),
        architecture,
        nodeName: "owned-node",
        kernel: "6.12.0",
        boundedBytes: 8589934592 as const,
        claimGiB: 32 as const,
      };
      const input: FactoryboxRuntimeInput = {
        attemptID: owned.attemptID,
        namespace: attempt.namespace,
        podName: attempt.podName,
        runtimeOwnerID: attempt.workspaceID,
        labels: {
          "app.kubernetes.io/managed-by": "open-software-factory",
          "factory.dev/runtime-owner": attempt.workspaceID,
          "factory.dev/project": owned.projectID,
          "factory.dev/runtime-attempt": owned.attemptID,
          "factory.dev/runtime-generation": String(attempt.generation),
        },
        runtimeHostImage: `registry.invalid/runtime@sha256:${"c".repeat(64)}`,
        profile,
        sharedSource: true,
      };
      await database.client`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${owned.attemptID}`;
      await database.client`DELETE FROM factory.runtime_artifact_intent WHERE runtime_attempt_id=${owned.attemptID}`;
      await database.client`INSERT INTO factory.runtime_artifact_intent(runtime_attempt_id,role,runtime_host_image,browser_tools_image,factorybox_profile)
      VALUES(${owned.attemptID},'build',${input.runtimeHostImage},${`registry.invalid/browser@sha256:${"d".repeat(64)}`},${JSON.stringify(profile)}::text::jsonb)`;
      await database.client`UPDATE factory.runtime_attempt SET state='starting',kubernetes_namespace_uid='namespace-uid',kubernetes_uid='pod-uid' WHERE id=${owned.attemptID}`;
      const request = factoryboxRuntimeRequest(input);
      const declared = factoryboxRuntimeDeclaration(input);
      const epoch = "e".repeat(32);
      const root = `/var/lib/sysbox/fixed-store/data/store/epochs/${epoch}/controller`;
      const namespace = { metadata: { ...declared.namespace.metadata, uid: "namespace-uid" } };
      const claim = {
        ...declared.claim,
        metadata: { ...declared.claim.metadata, uid: "claim-uid" },
        spec: { ...declared.claim.spec, volumeMode: "Filesystem" },
        status: { phase: "Bound" },
      };
      const pod = {
        ...declared.pod,
        metadata: { ...declared.pod.metadata, uid: "pod-uid" },
        spec: { ...declared.pod.spec, nodeName: profile.nodeName },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
          containerStatuses: [{ name: "worker", restartCount: 0, ready: true }],
        },
      };
      const node = {
        metadata: { name: profile.nodeName },
        status: {
          nodeInfo: {
            operatingSystem: "linux",
            architecture,
            kernelVersion: profile.kernel,
            bootID: "boot-id",
          },
        },
      };
      const status = {
        schema: 1,
        store_id: request.storeID,
        store: "/var/lib/sysbox/fixed-store/data/store",
        epoch,
        boot_id: "boot-id",
        supervisor_sha256: profile.executableSHA256,
        supervisor: { pid: 1 },
        ready_at: "2026-10-25T10:00:00Z",
        lifecycle: {
          root,
          manager_root: "/var/lib/sysbox/fixed-store/data/store/manager",
          bounded_store: {
            target: "/var/lib/sysbox/fixed-store/data",
            direct_io: true,
            image: { owner: request.storeID, bytes: profile.boundedBytes },
          },
        },
      };
      const record: {
        version: number;
        id: string;
        owner: string;
        phase: string;
        input_sha256: string;
        pause?: { snapshot_id: string; completed_at: string; resume?: { completed_at: string } };
      } = {
        version: 1,
        id: "runtime",
        owner: "f".repeat(32),
        phase: "starting",
        input_sha256: "1".repeat(64),
      };
      const mutations: string[] = [];
      let preparations = 0;
      let releases = 0;
      const run: typeof runFactoryboxKubernetes = async (args) => {
        if (args[0] === "get")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              ({ namespace, pvc: claim, pod, node } as Record<string, unknown>)[args[1] ?? ""],
            ),
          };
        if (args.at(-1) === "worker-status")
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(status) };
        if (args.includes("python3")) {
          if (args.at(-1) === "release") {
            releases++;
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({ version: 1, released: true }),
            };
          }
          preparations++;
          const [intent] = await database.client<
            Array<{ attempted: boolean }>
          >`SELECT attempted_at IS NOT NULL AS attempted FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${owned.attemptID} AND action='prepare'`;
          expect(intent?.attempted).toBe(true);
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              version: 1,
              bundle: `/var/lib/sysbox/fixed-store/data/store/input/${request.storeID}/bundle`,
              configSHA256: "1".repeat(64),
              rootfsSHA256: "2".repeat(64),
              storeID: request.storeID,
              epoch,
              podUID: "pod-uid",
            }),
          };
        }
        const index = args.indexOf("--worker-epoch");
        const action = args[index + 2];
        if (!action) throw new Error("Missing lifecycle command");
        if (action !== "state") {
          mutations.push(action);
          const [intent] = await database.client<
            Array<{ attempted: boolean }>
          >`SELECT attempted_at IS NOT NULL AS attempted FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${owned.attemptID} AND action=${action} AND completed_at IS NULL`;
          expect(intent?.attempted).toBe(true);
        }
        if (action === "start") {
          record.phase = "running";
          return { exitCode: 1, stderr: "response lost after completed native Start", stdout: "" };
        }
        if (action === "pause") {
          record.phase = "paused";
          record.pause = {
            snapshot_id: args[args.indexOf("--snapshot-id") + 1]!,
            completed_at: "2026-10-25T10:01:00Z",
          };
        }
        if (action === "resume") {
          record.phase = "running";
          if (!record.pause) throw new Error("Missing Pause");
          record.pause.resume = { completed_at: "2026-10-25T10:02:00Z" };
        }
        if (action === "delete") {
          record.phase = "deleted";
          return { exitCode: 1, stderr: "response lost after completed native Delete", stdout: "" };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            record,
            runtime: { status: record.phase === "running" ? "running" : "stopped" },
          }),
        };
      };
      const hub = new RuntimeHub(async () => {});
      const execution = createFactoryboxExecution(database, hub, run);
      await expect(execution.ensureStarted(owned.attemptID, [declared.pod])).rejects.toThrow(
        "unconfirmed",
      );
      const recovered = createFactoryboxExecution(database, hub, run);
      expect(await recovered.startupResources(owned.attemptID)).toEqual([declared.pod]);
      await recovered.ensureStarted(owned.attemptID);
      expect(mutations).toEqual(["start"]);
      expect(preparations).toBe(1);
      await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
      await execution.pause(owned.attemptID);
      const [paused] = await database.client<
        Array<{ state: string; generation: string; parent: string; child: string }>
      >`SELECT state,generation,parent_connector_token_hash AS parent,child_connector_token_hash AS child FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(paused).toEqual({
        state: "paused",
        generation: attempt.generation,
        parent: attempt.parent,
        child: attempt.child,
      });
      await execution.resume(owned.attemptID);
      expect(mutations).toEqual(["start", "pause", "resume"]);
      const [resumed] = await database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(resumed?.state).toBe("starting");
      const completed =
        await database.client`SELECT id FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${owned.attemptID} AND completed_at IS NOT NULL`;
      expect(completed).toHaveLength(4);
      await expect(
        (async () => {
          await database.client`UPDATE factory.factorybox_runtime SET identity='{}'::jsonb WHERE runtime_attempt_id=${owned.attemptID}`;
        })(),
      ).rejects.toThrow("immutable");
      await expect(
        (async () => {
          await database.client`UPDATE factory.factorybox_lifecycle_operation SET snapshot_id=${"a".repeat(32)} WHERE runtime_attempt_id=${owned.attemptID} AND action='pause'`;
        })(),
      ).rejects.toThrow("immutable");
      await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
      pod.metadata.uid = "foreign-pod";
      await expect(execution.pause(owned.attemptID)).rejects.toThrow("UID changed");
      expect(mutations).toEqual(["start", "pause", "resume"]);
      const [refused] = await database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(refused?.state).toBe("pausing");
      pod.metadata.uid = "pod-uid";
      await database.client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${owned.attemptID}`;
      await expect(execution.deleteSandbox(owned.attemptID)).rejects.toThrow("unconfirmed");
      await execution.deleteSandbox(owned.attemptID);
      await execution.deleteSandbox(owned.attemptID);
      expect(mutations).toEqual(["start", "pause", "resume", "delete"]);
      expect(releases).toBe(1);
      const [released] =
        await database.client`SELECT inputs_released_at FROM factory.factorybox_runtime WHERE runtime_attempt_id=${owned.attemptID}`;
      expect(released?.["inputs_released_at"]).not.toBeNull();
    } finally {
      await database.client.end({ timeout: 2 });
      await processFixture.dispose();
    }
  },
  60000,
);
