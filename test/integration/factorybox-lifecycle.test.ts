import { expect, test } from "bun:test";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import {
  type FactoryboxRuntimeInput,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeRequest,
  factoryboxSandboxID,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import type { runFactoryboxKubernetes } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

// Kubernetes and worker transport observations are fixtures. These cases prove
// persisted Factory ownership, not native qualification of either architecture.
test.each([
  ["arm64", false],
  ["amd64", false],
  ["arm64", true],
  ["amd64", true],
] as const)(
  "Factorybox %s preserves lifecycle and retirement ownership, reserve-deleted=%s",
  async (architecture, reserveDeleted) => {
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
          workerID: string;
        }>
      >`
      SELECT kubernetes_namespace AS namespace,kubernetes_pod_name AS "podName",workspace_id AS "workspaceID",generation,
        parent_connector_token_hash AS parent,child_connector_token_hash AS child,
        factorybox_worker_id AS "workerID" FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
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
        workerID: attempt.workerID,
        sandboxID: factoryboxSandboxID(owned.attemptID),
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
      await database.client`UPDATE factory.factorybox_worker SET profile=${JSON.stringify(profile)}::text::jsonb,
        runtime_host_image=${input.runtimeHostImage},node_name=${profile.nodeName},
        namespace_uid='namespace-uid',pod_uid='pod-uid',claim_uid='claim-uid',create_attempted=true
        WHERE id=${attempt.workerID}`;
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
      const assignment = {
        "assignment.json": JSON.stringify({
          version: 1,
          runtimeAttemptId: owned.attemptID,
          generation: Number(attempt.generation),
        }),
        "parent-token": "only-this-parent",
        "child-token": "only-this-child",
      };
      const secret = {
        metadata: { labels: input.labels },
        data: Object.fromEntries(
          Object.entries(assignment).map(([key, value]) => [
            key,
            Buffer.from(value).toString("base64"),
          ]),
        ),
      };
      const record: {
        version: number;
        id: string;
        owner: string;
        phase: string;
        input_sha256: string;
        pause?: {
          snapshot_id: string;
          checkpoint_sha256: string;
          completed_at: string;
          resume?: { completed_at: string };
        };
        pause_history?: unknown[];
      } = {
        version: 1,
        id: input.sandboxID,
        owner: "f".repeat(32),
        phase: "starting",
        input_sha256: "1".repeat(64),
      };
      const mutations: string[] = [];
      let preparations = 0;
      let releases = 0;
      const reclaimed = new Set<string>();
      let lostRetirementReply = false;
      let resumeCommands = 0;
      const activeSnapshot = () => {
        const snapshot = record.pause?.snapshot_id;
        if (!snapshot) throw new Error("Missing native snapshot");
        return snapshot;
      };
      const retirement = (snapshot: string) => ({
        version: 1,
        request: {
          source_id: input.sandboxID,
          snapshot_id: snapshot,
          source_owner: record.owner,
          checkpoint_sha256: "2".repeat(64),
        },
        intent_sha256: "3".repeat(64),
        completed_at: "2026-10-26T10:02:01Z",
        before: { root, filesystem_available_bytes: 1024 },
        after: { root, filesystem_available_bytes: 2048 },
      });
      const run: typeof runFactoryboxKubernetes = async (args, body) => {
        if (args[0] === "get")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              ({ namespace, pvc: claim, pod, node, secret } as Record<string, unknown>)[
                args[1] ?? ""
              ],
            ),
          };
        if (args.at(-1) === "worker-status")
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(status) };
        if (args.includes("python3")) {
          expect(JSON.parse(body ?? "null").sandboxID).toBe(input.sandboxID);
          if (args.at(-1) === "release") {
            expect(JSON.parse(body ?? "null").assignment).toBeUndefined();
            releases++;
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({ version: 1, released: true }),
            };
          }
          preparations++;
          expect(JSON.parse(body ?? "null").assignment).toEqual(assignment);
          expect(JSON.parse(body ?? "null").sourceWorkspaceID).toBe(
            attempt.workspaceID.replaceAll("-", ""),
          );
          const [intent] = await database.client<
            Array<{ attempted: boolean }>
          >`SELECT attempted_at IS NOT NULL AS attempted FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${owned.attemptID} AND action='prepare'`;
          expect(intent?.attempted).toBe(true);
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              version: 3,
              sandboxID: input.sandboxID,
              bundle: `/var/lib/sysbox/fixed-store/data/store/input/${input.sandboxID}/bundle`,
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
        expect(args.at(-1)).toBe(input.sandboxID);
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
          if (record.pause) {
            record.pause_history ??= [];
            record.pause_history.push(record.pause);
          }
          const snapshot = args[args.indexOf("--snapshot-id") + 1];
          if (!snapshot) throw new Error("Missing native Pause snapshot");
          record.pause = {
            snapshot_id: snapshot,
            checkpoint_sha256: "2".repeat(64),
            completed_at: "2026-10-25T10:01:00Z",
          };
        }
        if (action === "resume") {
          resumeCommands++;
          record.phase = "running";
          if (!record.pause) throw new Error("Missing Pause");
          record.pause.resume = { completed_at: "2026-10-25T10:02:00Z" };
          if (resumeCommands === 2)
            return { exitCode: 1, stderr: "reply lost after the second native Resume", stdout: "" };
        }
        if (action === "retire-checkpoint") {
          if (!record.pause) throw new Error("Missing checkpoint");
          expect(args[args.indexOf("--source-owner") + 1]).toBe(record.owner);
          expect(args[args.indexOf("--checkpoint-sha256") + 1]).toBe("2".repeat(64));
          expect(args[args.indexOf("--snapshot-id") + 1]).toBe(record.pause.snapshot_id);
          reclaimed.add(record.pause.snapshot_id);
          if (!lostRetirementReply) {
            lostRetirementReply = true;
            return {
              exitCode: 1,
              stderr: "reply lost after exact checkpoint retirement",
              stdout: "",
            };
          }
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(retirement(record.pause.snapshot_id)),
          };
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
      const [privateInput] = await database.client<
        Array<{ request: string }>
      >`SELECT request::text AS request FROM factory.factorybox_runtime WHERE runtime_attempt_id=${owned.attemptID}`;
      expect(privateInput?.request).not.toContain("only-this-parent");
      expect(privateInput?.request).not.toContain("only-this-child");
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
      const [pauseIdentity] = await database.client<
        Array<{ observation: { checkpointSHA256: string } }>
      >`SELECT observation FROM factory.factorybox_lifecycle_operation
        WHERE runtime_attempt_id=${owned.attemptID} AND action='pause' AND completed_at IS NOT NULL`;
      expect(pauseIdentity?.observation.checkpointSHA256).toBe("2".repeat(64));
      await execution.reclaimStorage();
      expect(mutations).toEqual(["start", "pause"]);
      expect(reclaimed.size).toBe(0);
      await execution.resume(owned.attemptID);
      expect(mutations).toEqual(["start", "pause", "resume"]);
      const [resumed] = await database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(resumed?.state).toBe("starting");
      const completed =
        await database.client`SELECT id FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${owned.attemptID} AND completed_at IS NOT NULL`;
      expect(completed).toHaveLength(4);
      const [pendingRetirement] = await database.client<
        Array<{ request: unknown; completed: boolean }>
      >`SELECT request,completed_at IS NOT NULL AS completed FROM factory.factorybox_lifecycle_operation
        WHERE runtime_attempt_id=${owned.attemptID} AND action='retire-checkpoint'`;
      expect(pendingRetirement?.completed).toBe(false);
      expect(pendingRetirement?.request).toEqual(retirement(activeSnapshot()).request);
      await expect(
        (async () => {
          await database.client`UPDATE factory.factorybox_lifecycle_operation SET request='{}'::jsonb
            WHERE runtime_attempt_id=${owned.attemptID} AND action='retire-checkpoint'`;
        })(),
      ).rejects.toThrow("immutable");
      await Promise.all([execution.reclaimStorage(), execution.reclaimStorage()]);
      expect(reclaimed.size).toBe(1);
      const [unconfirmed] = await database.client<
        Array<{ attempted: boolean; completed: boolean }>
      >`SELECT attempted_at IS NOT NULL AS attempted,completed_at IS NOT NULL AS completed
        FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${owned.attemptID} AND action='retire-checkpoint'`;
      expect(unconfirmed).toEqual({ attempted: true, completed: false });
      const [stillRunning] = await database.client<
        Array<{ state: string; failure: string | null }>
      >`SELECT state,failure FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(stillRunning).toEqual({ state: "starting", failure: null });
      const retentionRecovered = createFactoryboxExecution(database, hub, run);
      await retentionRecovered.reclaimStorage();
      await retentionRecovered.reclaimStorage();
      const [retired] = await database.client<
        Array<{ observation: unknown }>
      >`SELECT observation FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${owned.attemptID} AND action='retire-checkpoint' AND completed_at IS NOT NULL`;
      expect(retired?.observation).toEqual({
        version: 1,
        request: retirement(activeSnapshot()).request,
        intentSHA256: "3".repeat(64),
        completedAt: "2026-10-26T10:02:01Z",
        availableBytesBefore: 1024,
        availableBytesAfter: 2048,
      });
      expect(mutations).toEqual([
        "start",
        "pause",
        "resume",
        "retire-checkpoint",
        "retire-checkpoint",
      ]);
      await expect(
        (async () => {
          await database.client`UPDATE factory.factorybox_lifecycle_operation SET request='{}'::jsonb
            WHERE runtime_attempt_id=${owned.attemptID} AND action='retire-checkpoint'`;
        })(),
      ).rejects.toThrow("immutable");
      await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
      await execution.pause(owned.attemptID);
      const secondSnapshot = activeSnapshot();
      await execution.reclaimStorage();
      expect(reclaimed.has(secondSnapshot)).toBe(false);
      await expect(execution.resume(owned.attemptID)).rejects.toThrow("unconfirmed");
      expect(resumeCommands).toBe(2);
      const [lostResume] = await database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      expect(lostResume?.state).toBe("resuming");
      const resumeRecovered = createFactoryboxExecution(database, hub, run);
      await resumeRecovered.resume(owned.attemptID);
      expect(resumeCommands).toBe(2);
      await resumeRecovered.reclaimStorage();
      expect(reclaimed.size).toBe(2);
      expect(reclaimed.has(secondSnapshot)).toBe(true);
      const settledMutations = [...mutations];
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
      if (reserveDeleted) {
        await execution.pause(owned.attemptID);
        expect(reclaimed.has(activeSnapshot())).toBe(false);
        // The reserve controller already confirmed this same native Delete.
        // Runtime Attempt cleanup must observe it and retire the final Pause.
        record.phase = "deleted";
      } else {
        pod.metadata.uid = "foreign-pod";
        await expect(execution.pause(owned.attemptID)).rejects.toThrow("UID changed");
        expect(mutations).toEqual(settledMutations);
        const [refused] = await database.client<
          Array<{ state: string }>
        >`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
        expect(refused?.state).toBe("pausing");
        pod.metadata.uid = "pod-uid";
      }
      await database.client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${owned.attemptID}`;
      if (!reserveDeleted)
        await expect(execution.deleteSandbox(owned.attemptID)).rejects.toThrow("unconfirmed");
      await execution.deleteSandbox(owned.attemptID, reserveDeleted);
      await execution.deleteSandbox(owned.attemptID, reserveDeleted);
      expect(mutations).toEqual([
        ...settledMutations,
        ...(reserveDeleted ? ["pause", "retire-checkpoint"] : ["delete"]),
      ]);
      expect(reclaimed.size).toBe(reserveDeleted ? 3 : 2);
      expect(releases).toBe(1);
      const [released] = await database.client<
        Array<{ inputs_released_at: Date | null }>
      >`SELECT inputs_released_at FROM factory.factorybox_runtime WHERE runtime_attempt_id=${owned.attemptID}`;
      expect(released?.inputs_released_at).not.toBeNull();
      expect(
        await database.client`SELECT id FROM factory.development_workspace WHERE id=${attempt.workspaceID}`,
      ).toHaveLength(1);
      expect(
        await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${owned.ticketID}`,
      ).toHaveLength(1);
    } finally {
      await database.client.end({ timeout: 2 });
      await processFixture.dispose();
    }
  },
  60000,
);
