import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/client";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import {
  nativeActor,
  nativeSnapshot,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { type RuntimeArtifacts, runtimeArtifactNames } from "../../scripts/factory/artifacts";
import { integrationLane } from "../../scripts/testing/lanes";
import { controlledStarterInput } from "../fixtures/starter";
import {
  requireStarterActorAbsent,
  requireStarterNativeContract,
  requireStarterRetainedLifecycleEvidence,
  starterArtifactDirectory,
  starterNativeLifecycle,
} from "../fixtures/starter-native-lifecycle";

const workspaceID = crypto.randomUUID();
const attemptID = crypto.randomUUID();
type ToolInput = Parameters<Client["callTool"]>[0];
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function response(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}
function controlledClient(execute: (input: ToolInput) => ToolResult | Promise<ToolResult>) {
  const calls: ToolInput[] = [];
  const timeouts: Array<number | undefined> = [];
  const client: Pick<Client, "callTool"> = {
    callTool: async (input, options) => {
      calls.push(input);
      timeouts.push(options?.timeout);
      return execute(input);
    },
  };
  return { client, calls, timeouts };
}
const commandView = (id: unknown, state = "running") => ({
  commandID: id,
  workspaceID,
  attemptID,
  state,
  exitCode: state === "exited" ? 0 : null,
});
const commandPage = (id: unknown, extra: Record<string, unknown> = {}) => ({
  ...commandView(id, "exited"),
  stdout: "native compiler/tests completed",
  stderr: "",
  outputAvailable: true,
  outputLost: false,
  stdoutFrom: 0,
  stderrFrom: 0,
  stdoutNext: 31,
  stderrNext: 0,
  ...extra,
});

test("Starter proof stays explicit live-only and selects an absolute artifact override", async () => {
  expect(integrationLane("test/integration/starter-runtime.live.test.ts")).toBe("live");
  expect(starterArtifactDirectory(undefined)).toBe(".factory");
  expect(starterArtifactDirectory("/owned/starter/artifacts")).toBe("/owned/starter/artifacts");
  for (const path of ["", ".factory/owned", "../artifacts"])
    expect(() => starterArtifactDirectory(path)).toThrow("absolute owned artifact directory");
  const source = await readFile("test/integration/starter-runtime.live.test.ts", "utf8");
  expect(source).toContain('process.env["FACTORY_RUN_STARTER_RUNTIME_PROOF"] !== "1"');
  expect(source).toContain("requirePublishedRuntimeArtifacts(artifactDirectory)");
  expect(source).toContain("artifactDirectory,");
  expect(source.indexOf("await nativeLiveArtifacts(")).toBeLessThan(
    source.indexOf("await localOpenBao("),
  );
  expect(source).not.toContain("Envbox");
  expect(source).not.toContain("pinned Feature installation");
  expect(source).toContain("await starterRuntimeJourney({");
  const journey = await readFile("test/fixtures/starter-runtime-journey.ts", "utf8");
  expect(journey.indexOf('"ensurePersonalSource"')).toBeLessThan(
    journey.indexOf('"Starter setup preview did not become ready"'),
  );
  expect(journey.indexOf("requireStarterNativeContract(templateFile.content")).toBeLessThan(
    journey.indexOf('"Starter setup preview did not become ready"'),
  );
  expect(journey.match(/"ensurePersonalSource"/g)).toHaveLength(1);
  expect(journey).not.toContain("offline Save");
});

test("Starter source retains direct Work/PostgreSQL containers and exact published digests", async () => {
  const files = await starterFiles(controlledStarterInput);
  const authored = files.find((file) => file.path === ".factory/actor-template.json");
  if (!authored) throw Error("Authored Starter native template missing");
  const artifacts = Object.fromEntries(
    runtimeArtifactNames.map((role) => [
      role,
      role === "starter-work"
        ? controlledStarterInput.images.development
        : controlledStarterInput.images.postgres,
    ]),
  ) as RuntimeArtifacts;
  const valid = requireStarterNativeContract(authored.content, artifacts);
  for (const role of ["starter-work", "starter-postgres"] as const)
    expect(() =>
      requireStarterNativeContract(authored.content, {
        ...artifacts,
        [role]: `registry.example.invalid/different@sha256:${"c".repeat(64)}`,
      }),
    ).toThrow();
  expect(() =>
    requireStarterNativeContract(
      JSON.stringify({
        ...valid,
        containers: valid.containers.map((container) =>
          container.name === "work" ? { ...container, command: ["true"] } : container,
        ),
      }),
      artifacts,
    ),
  ).toThrow();
  expect(() =>
    requireStarterNativeContract(
      JSON.stringify({
        ...valid,
        containers: valid.containers.map((container) =>
          container.name === "postgres"
            ? { ...container, command: ["/usr/local/bin/docker-entrypoint.sh", "postgres"] }
            : container,
        ),
      }),
      artifacts,
    ),
  ).toThrow();
});

test("destructive disposal evidence requires the exact original Actor and real NotFound, not Pause", async () => {
  const binding = { atespace: "fa-owned", actorName: "runtime-owned" };
  const calls: unknown[] = [];
  await requireStarterActorAbsent(async (method, request) => {
    calls.push({ method, request });
    throw new SubstrateRPCError("NotFound", "Original Actor is absent");
  }, binding);
  expect(calls).toEqual([
    {
      method: "GetActor",
      request: { actor: { atespace: binding.atespace, name: binding.actorName } },
    },
  ]);
  await expect(
    requireStarterActorAbsent(async () => ({ metadata: { uid: crypto.randomUUID() } }), binding),
  ).rejects.toThrow("still exists");
  for (const code of ["Unavailable", "PermissionDenied"])
    await expect(
      requireStarterActorAbsent(async () => {
        throw new SubstrateRPCError(code, "Unconfirmed native observation");
      }, binding),
    ).rejects.toMatchObject({ code });
});

test("current Source reads and saves may wake the retained owner and use exact file versions", async () => {
  const f = controlledClient((input) =>
    response(
      input.name === "readFile"
        ? { content: "saved checkout", version: "observed-version", nextOffset: null }
        : {},
    ),
  );
  const lane = starterNativeLifecycle(f.client);
  const saved = await lane.file(workspaceID, "src/db/schema.ts");
  await lane.save(workspaceID, "src/db/schema.ts", `${saved.content}\n// saved`, saved.version);
  expect(f.calls.map((call) => call.name)).toEqual(["readFile", "writeFile"]);
  expect(f.calls[1]?.arguments).toMatchObject({ version: "observed-version", workspaceID });
  expect(f.timeouts).toEqual([nativeLifecycleWindowMS + 30_000, nativeLifecycleWindowMS + 30_000]);
  const paged = controlledClient(() =>
    response({ content: "partial", version: "observed-version", nextOffset: 16384 }),
  );
  await expect(
    starterNativeLifecycle(paged.client).file(workspaceID, "src/db/schema.ts"),
  ).rejects.toThrow("single-page bound");
});

test("ordinary halt is only public Pause with a replayable requestID, not destructive Stop", async () => {
  const projectID = crypto.randomUUID();
  const requestID = crypto.randomUUID();
  const view = { id: attemptID, projectId: projectID, workspaceId: workspaceID, state: "pausing" };
  const f = controlledClient(() => response(view));
  const lane = starterNativeLifecycle(f.client);
  expect("stop" in lane).toBe(false);
  // Pending is returned immediately, not polled to App health or called success.
  expect(await lane.pause(workspaceID, requestID)).toEqual(view);
  expect(f.calls).toEqual([{ name: "pauseWorkspace", arguments: { workspaceID, requestID } }]);
  expect(await lane.pause(workspaceID, requestID)).toEqual(view);
  expect(f.calls[1]).toEqual(f.calls[0]);
  expect(f.timeouts).toEqual([nativeLifecycleWindowMS + 30_000, nativeLifecycleWindowMS + 30_000]);
});

test("native Pause does not require the obsolete independent-service handoff evidence", async () => {
  const view = {
    id: attemptID,
    projectId: crypto.randomUUID(),
    workspaceId: workspaceID,
    state: "paused",
    native: {
      engine: "substrate",
      actorUID: crypto.randomUUID(),
      state: "ACTOR_STATE_SUSPENDED",
      coldRestart: true,
      portable: false,
      sourceHandoff: "pending",
    },
  };
  const f = controlledClient(() => response(view));
  expect(
    await starterNativeLifecycle(f.client).pause(workspaceID, crypto.randomUUID()),
  ).toMatchObject({
    id: attemptID,
    workspaceId: workspaceID,
    state: "paused",
    native: { actorUID: view.native.actorUID, state: "ACTOR_STATE_SUSPENDED" },
  });
  expect(f.calls.map((call) => call.name)).toEqual(["pauseWorkspace"]);
});

test("the caller owns each deliberate Pause/Resume ID before dispatch, including on failure", async () => {
  const f = controlledClient(() =>
    response({
      id: attemptID,
      projectId: crypto.randomUUID(),
      workspaceId: workspaceID,
      state: "paused",
    }),
  );
  const lane = starterNativeLifecycle(f.client);
  const firstPauseID = crypto.randomUUID();
  const secondPauseID = crypto.randomUUID();
  await lane.pause(workspaceID, firstPauseID);
  await lane.pause(workspaceID, secondPauseID);
  const requestID = crypto.randomUUID();
  await lane.start(workspaceID, requestID);
  expect(f.calls.map((call) => call.name)).toEqual([
    "pauseWorkspace",
    "pauseWorkspace",
    "startWorkspace",
  ]);
  expect(f.calls[0]?.arguments).toEqual({ workspaceID, requestID: firstPauseID });
  expect(f.calls[1]?.arguments).toEqual({ workspaceID, requestID: secondPauseID });
  expect(f.calls[2]?.arguments).toEqual({ workspaceID, requestID });
  expect(() => lane.pause(workspaceID, "invalid-request")).toThrow();
  expect(() => lane.start(workspaceID, "invalid-request")).toThrow();
  expect(() => Reflect.apply(lane.pause, null, [workspaceID])).toThrow();
  expect(() => Reflect.apply(lane.start, null, [workspaceID])).toThrow();
  expect(f.calls).toHaveLength(3);
});

test.each(["lost-reply", "uncertain", "active-coding"] as const)(
  "Pause never retries or reports success on %s",
  async (fault) => {
    const requestID = crypto.randomUUID();
    const f = controlledClient(() => {
      if (fault === "lost-reply") throw Error("Owned Pause reply lost after dispatch");
      if (fault === "uncertain") return response({ requestID, state: "uncertain" });
      return response(
        { error: { code: "conflict", message: "Stop Coding before pausing this Workspace" } },
        true,
      );
    });
    await expect(starterNativeLifecycle(f.client).pause(workspaceID, requestID)).rejects.toThrow();
    expect(f.calls).toEqual([{ name: "pauseWorkspace", arguments: { workspaceID, requestID } }]);
  },
);

test("passive Workspace observation has no wake, lifecycle or inference request", async () => {
  const view = {
    workspaceID,
    runtime: { id: attemptID, projectId: crypto.randomUUID(), state: "paused" },
  };
  const f = controlledClient(() => response(view));
  expect(await starterNativeLifecycle(f.client).workspace(workspaceID)).toEqual(view);
  expect(f.calls).toEqual([{ name: "getWorkspace", arguments: { workspaceID } }]);
  expect(f.timeouts).toEqual([30_000]);
});

function controlledRetentionEvidence(
  fidelity: "SNAPSHOT_FIDELITY_MEMORY" | "SNAPSHOT_FIDELITY_ROOTFS",
) {
  const actorUID = crypto.randomUUID();
  const templateUID = crypto.randomUUID();
  const atespace = `fa-${attemptID.replaceAll("-", "")}`;
  const sandboxRuntime = {
    sandboxClass: "gvisor",
    version: {
      schemaVersion: "v1",
      attributes: [
        { key: "architecture", value: "amd64" },
        { key: "sandbox_bundle_hash", value: `sha256:${"a".repeat(64)}` },
      ],
    },
  };
  const snapshot = nativeSnapshot.parse({
    uuid: crypto.randomUUID(),
    generation: 1,
    owner: "SNAPSHOT_OWNER_ACTOR",
    fidelity,
    actorTemplateUid: templateUID,
    sandboxRuntime,
    durableSnapshot: {
      state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
      object: { snapshotUri: "s3://owned/pending" },
    },
  });
  snapshot.durableSnapshot.object.snapshotUri = `s3://owned/atespaces/${atespace}/actors/${actorUID}/snapshots/${snapshot.uuid}`;
  const before = {
    attemptID,
    workspaceID,
    projectID: crypto.randomUUID(),
    generation: "1",
    state: "ready",
    actor: nativeActor.parse({
      metadata: {
        uid: actorUID,
        name: `runtime-${attemptID.replaceAll("-", "")}`,
        atespace,
        version: "2",
        createTime: "2026-11-25T00:00:00.000Z",
      },
      actorTemplate: { atespace, name: "runtime" },
      status: { state: "ACTOR_STATE_RUNNING", workerAssignment: { sandboxRuntime } },
    }),
    source: {
      workspaceID,
      actorUID,
      owner: "actor",
      writerEpoch: 3,
      generation: 1,
      writable: true,
      checkpointID: null,
      checkpoint: { id: crypto.randomUUID() },
      serviceBase: crypto.randomUUID(),
    },
    inference: { agentTurns: 0, agentSessions: 0, modelOperations: 0, modelUsageEntries: 0 },
    dirtySource: {
      path: "src/db/schema.ts",
      sha256: "a".repeat(64),
      gitStatus: " M src/db/schema.ts",
    },
    stagedSource: {
      path: "owned-staged.txt",
      sha256: "b".repeat(64),
      gitStatus: "A  owned-staged.txt",
    },
    untrackedSource: {
      path: "owned-untracked.txt",
      sha256: "c".repeat(64),
      gitStatus: "?? owned-untracked.txt",
    },
    rootfs: {
      path: `/home/node/factory-starter-${crypto.randomUUID()}.rootfs` as const,
      sha256: "d".repeat(64),
      mtimeNs: "1795564800123456789",
    },
    process: {
      bootID: crypto.randomUUID(),
      pid: 123,
      instanceID: crypto.randomUUID(),
      memoryNonce: crypto.randomUUID(),
      challenge: crypto.randomUUID(),
      counter: 1,
    },
    compiler: {
      commandID: crypto.randomUUID(),
      workspaceID,
      attemptID,
      state: "exited",
      exitCode: 0,
      stdout: "tsc --noEmit\nfail 0",
    },
    appStatus: 200,
  };
  const {
    dirtySource: _dirty,
    stagedSource: _staged,
    untrackedSource: _untracked,
    rootfs: _rootfs,
    process: _process,
    compiler: _compiler,
    appStatus: _app,
    ...paused
  } = structuredClone(before);
  paused.state = "paused";
  paused.actor.metadata.version = "3";
  paused.actor.status.state = "ACTOR_STATE_SUSPENDED";
  delete paused.actor.status.workerAssignment;
  paused.actor.status.lastAssignedGeneration = 1;
  paused.actor.status.snapshots = [snapshot];
  const after = structuredClone(before);
  after.actor.metadata.version = "4";
  after.compiler.commandID = crypto.randomUUID();
  after.process.challenge = crypto.randomUUID();
  after.process.counter++;
  if (fidelity === "SNAPSHOT_FIDELITY_ROOTFS") {
    after.process.bootID = crypto.randomUUID();
    after.process.memoryNonce = crypto.randomUUID();
    after.process.instanceID = crypto.randomUUID();
    after.process.counter = 1;
  }
  return { before, paused, after, templateUID, fidelity };
}

test.each(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"] as const)(
  "controlled %s evidence guards require the same Actor/Attempt/Source owner and epoch, not export",
  (fidelity) => {
    const evidence = controlledRetentionEvidence(fidelity);
    // ROOTFS deliberately reuses a PID/counter; boot and RAM identities change.
    expect(evidence.after.process.pid).toBe(evidence.before.process.pid);
    requireStarterRetainedLifecycleEvidence(evidence);
  },
);

function controlledFallbackEvidence() {
  const evidence = controlledRetentionEvidence("SNAPSHOT_FIDELITY_ROOTFS");
  const snapshot = nativeSnapshot.parse(evidence.paused.actor.status.snapshots?.[0]);
  // Upstream retains the original MEMORY label when an incompatible runtime
  // forces detached Resume to restore only ROOTFS.
  evidence.paused.actor.status.snapshots = [{ ...snapshot, fidelity: "SNAPSHOT_FIDELITY_MEMORY" }];
  const runtime = evidence.after.actor.status.workerAssignment?.sandboxRuntime;
  if (!runtime) throw Error("Controlled fallback requires an assigned runtime");
  runtime.version.attributes = runtime.version.attributes.map((attribute) =>
    attribute.key === "sandbox_bundle_hash"
      ? { ...attribute, value: `sha256:${"b".repeat(64)}` }
      : attribute,
  );
  return evidence;
}

test("controlled detached MEMORY snapshot accepts ROOTFS fallback on a changed native runtime", () => {
  const evidence = controlledFallbackEvidence();
  const snapshot = nativeSnapshot.parse(evidence.paused.actor.status.snapshots?.[0]);
  expect(snapshot.fidelity).toBe("SNAPSHOT_FIDELITY_MEMORY");
  expect(evidence.fidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
  expect(evidence.after.process.pid).toBe(evidence.before.process.pid);
  const result = requireStarterRetainedLifecycleEvidence(evidence);
  expect(result.paused.actor.status.snapshots).toEqual([snapshot]);
  expect(result.after.rootfs).toEqual(evidence.before.rootfs);
});

test.each([
  {
    reason: "same-runtime MEMORY masquerading as ROOTFS",
    attributes: [
      { key: "architecture", value: "amd64" },
      { key: "sandbox_bundle_hash", value: `sha256:${"a".repeat(64)}` },
    ],
  },
  {
    reason: "attribute reordering without a runtime version change",
    attributes: [
      { key: "sandbox_bundle_hash", value: `sha256:${"a".repeat(64)}` },
      { key: "architecture", value: "amd64" },
    ],
  },
  {
    reason: "different CPU architecture",
    attributes: [
      { key: "architecture", value: "arm64" },
      { key: "sandbox_bundle_hash", value: `sha256:${"b".repeat(64)}` },
    ],
  },
  {
    reason: "missing CPU architecture",
    attributes: [{ key: "sandbox_bundle_hash", value: `sha256:${"b".repeat(64)}` }],
  },
  {
    reason: "ambiguous CPU architecture",
    attributes: [
      { key: "architecture", value: "amd64" },
      { key: "architecture", value: "amd64" },
      { key: "sandbox_bundle_hash", value: `sha256:${"b".repeat(64)}` },
    ],
  },
])("controlled MEMORY-to-ROOTFS fallback rejects $reason", ({ attributes }) => {
  const evidence = controlledFallbackEvidence();
  const runtime = evidence.after.actor.status.workerAssignment?.sandboxRuntime;
  if (!runtime) throw Error("Controlled fallback requires an assigned runtime");
  runtime.version.attributes = [...attributes];
  expect(() => requireStarterRetainedLifecycleEvidence(evidence)).toThrow();
});

test.each(
  (["explicit ROOTFS snapshot", "MEMORY snapshot fallback"] as const).flatMap((kind) =>
    [
      "VOLUMES-only retention / reboot without rootfs",
      "lost rootfs contents",
      "rewritten rootfs mtime",
      "replacement rootfs path",
      "unchanged sandbox boot",
    ].map((fault) => ({ kind, fault })),
  ),
)("controlled $kind rejects $fault", ({ kind, fault }) => {
  const evidence =
    kind === "explicit ROOTFS snapshot"
      ? controlledRetentionEvidence("SNAPSHOT_FIDELITY_ROOTFS")
      : controlledFallbackEvidence();
  // Source and restarted-process evidence remain valid in every case.
  expect(evidence.after.dirtySource).toEqual(evidence.before.dirtySource);
  if (fault === "VOLUMES-only retention / reboot without rootfs")
    Reflect.deleteProperty(evidence.after, "rootfs");
  if (fault === "lost rootfs contents") evidence.after.rootfs.sha256 = "e".repeat(64);
  if (fault === "rewritten rootfs mtime") evidence.after.rootfs.mtimeNs = "1795564800123456790";
  if (fault === "replacement rootfs path")
    evidence.after.rootfs.path = `/home/node/factory-starter-${crypto.randomUUID()}.rootfs`;
  if (fault === "unchanged sandbox boot")
    evidence.after.process.bootID = evidence.before.process.bootID;
  expect(() => requireStarterRetainedLifecycleEvidence(evidence)).toThrow();
});

test.each([
  { path: "/workspace/factory-starter-owned.rootfs" },
  { path: "/data/factory-starter-owned.rootfs" },
  { path: "/home/node/factory-starter-not-a-uuid.rootfs" },
  { sha256: "not-a-sha256" },
  { mtimeNs: Number("1795564800123456789") },
  { mtimeNs: "" },
  { mtimeNs: "1795564800.123456789" },
])("controlled rootfs witness rejects unowned paths or invalid metadata: %j", (extra) => {
  const evidence = controlledRetentionEvidence("SNAPSHOT_FIDELITY_ROOTFS");
  const rootfs = { ...evidence.before.rootfs, ...extra };
  expect(() =>
    requireStarterRetainedLifecycleEvidence({
      ...evidence,
      before: { ...evidence.before, rootfs },
      after: { ...evidence.after, rootfs },
    }),
  ).toThrow();
});

test.each([
  { reason: "replacement Attempt", path: ["after", "attemptID"], value: crypto.randomUUID() },
  {
    reason: "replacement Actor",
    path: ["after", "actor", "metadata", "uid"],
    value: crypto.randomUUID(),
  },
  { reason: "successor generation", path: ["after", "generation"], value: "2" },
  { reason: "Source service handoff", path: ["paused", "source", "owner"], value: "service" },
  { reason: "Source writer epoch change", path: ["after", "source", "writerEpoch"], value: 5 },
  { reason: "Source export generation", path: ["paused", "source", "generation"], value: 2 },
  {
    reason: "Source export receipt",
    path: ["paused", "source", "checkpoint"],
    value: { id: crypto.randomUUID() },
  },
  { reason: "frozen Source", path: ["paused", "source", "writable"], value: false },
  {
    reason: "pending Source checkpoint",
    path: ["paused", "source", "checkpointID"],
    value: crypto.randomUUID(),
  },
  {
    reason: "missing confirmed detach",
    path: ["paused", "actor", "status", "workerAssignment"],
    value: {
      sandboxRuntime: {
        sandboxClass: "gvisor",
        version: {
          schemaVersion: "v1",
          attributes: [{ key: "architecture", value: "amd64" }],
        },
      },
    },
  },
  {
    reason: "node-pinned Pause without workerAssignment",
    path: ["paused", "actor", "status", "assignedNode"],
    value: "owned-starter-node",
  },
  {
    reason: "unfinished native Pause",
    path: ["paused", "actor", "status", "state"],
    value: "ACTOR_STATE_SUSPENDING",
  },
  { reason: "no native snapshot", path: ["paused", "actor", "status", "snapshots"], value: [] },
  {
    reason: "wrong snapshot generation",
    path: ["paused", "actor", "status", "lastAssignedGeneration"],
    value: 2,
  },
  { reason: "missing dirty source", path: ["after", "dirtySource"], value: undefined },
  { reason: "missing staged source", path: ["after", "stagedSource"], value: undefined },
  { reason: "lost untracked source", path: ["after", "untrackedSource"], value: undefined },
  {
    reason: "lost index staging",
    path: ["after", "stagedSource", "gitStatus"],
    value: "?? owned-staged.txt",
  },
  {
    reason: "changed dirty source",
    path: ["after", "dirtySource", "sha256"],
    value: "b".repeat(64),
  },
  { reason: "clean checkout", path: ["before", "dirtySource", "gitStatus"], value: "" },
  { reason: "missing sandbox boot", path: ["before", "process", "bootID"], value: undefined },
  { reason: "invalid sandbox boot", path: ["after", "process", "bootID"], value: "not-a-uuid" },
  {
    reason: "MEMORY sandbox reboot",
    path: ["after", "process", "bootID"],
    value: crypto.randomUUID(),
  },
  { reason: "missing rootfs witness", path: ["before", "rootfs"], value: undefined },
  {
    reason: "MEMORY rootfs replacement",
    path: ["after", "rootfs", "mtimeNs"],
    value: "1795564800123456790",
  },
  { reason: "missing process evidence", path: ["after", "process"], value: undefined },
  {
    reason: "missing resumed runtime",
    path: ["after", "actor", "status", "workerAssignment"],
    value: undefined,
  },
  {
    reason: "MEMORY runtime version change",
    path: [
      "after",
      "actor",
      "status",
      "workerAssignment",
      "sandboxRuntime",
      "version",
      "attributes",
    ],
    value: [
      { key: "architecture", value: "amd64" },
      { key: "sandbox_bundle_hash", value: `sha256:${"b".repeat(64)}` },
    ],
  },
  {
    reason: "MEMORY process restart",
    path: ["after", "process", "memoryNonce"],
    value: crypto.randomUUID(),
  },
  { reason: "MEMORY PID replacement", path: ["after", "process", "pid"], value: 124 },
  {
    reason: "MEMORY process instance replacement",
    path: ["after", "process", "instanceID"],
    value: crypto.randomUUID(),
  },
  { reason: "no fresh process response", path: ["after", "process", "counter"], value: 1 },
  { reason: "failed compiler", path: ["after", "compiler", "exitCode"], value: 1 },
  {
    reason: "missing compiler output",
    path: ["after", "compiler", "stdout"],
    value: "command succeeded",
  },
  { reason: "unhealthy App", path: ["after", "appStatus"], value: 503 },
  { reason: "admitted inference", path: ["paused", "inference", "agentTurns"], value: 1 },
  { reason: "live Coding session", path: ["after", "inference", "agentSessions"], value: 1 },
  { reason: "model usage", path: ["after", "inference", "modelUsageEntries"], value: 1 },
])("controlled retained-lifecycle evidence rejects $reason", ({ path, value }) => {
  const evidence = controlledRetentionEvidence("SNAPSHOT_FIDELITY_MEMORY");
  let target = evidence as unknown as Record<string, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  const key = path.at(-1);
  if (!key) throw Error("Controlled negative evidence path is missing");
  target[key] = value;
  expect(() => requireStarterRetainedLifecycleEvidence(evidence)).toThrow();
});

test.each([
  "pending snapshot",
  "foreign snapshot",
  "duplicate snapshot",
  "foreign snapshot URI",
  "unconfirmed snapshot URI",
  "fidelity label only",
  "replayed compiler",
  "replayed probe",
  "ROOTFS process not restarted",
  "ROOTFS instance not restarted",
  "ROOTFS sandbox not rebooted",
] as const)("controlled lifecycle proof rejects %s", (fault) => {
  const evidence = controlledRetentionEvidence(
    fault.startsWith("ROOTFS") ? "SNAPSHOT_FIDELITY_ROOTFS" : "SNAPSHOT_FIDELITY_MEMORY",
  );
  const snapshot = nativeSnapshot.parse(evidence.paused.actor.status.snapshots?.[0]);
  if (fault === "pending snapshot")
    evidence.paused.actor.status.snapshots = [
      {
        ...snapshot,
        durableSnapshot: { ...snapshot.durableSnapshot, state: "SNAPSHOT_STORAGE_STATE_PENDING" },
      },
    ];
  if (fault === "foreign snapshot")
    evidence.paused.actor.status.snapshots = [
      { ...snapshot, actorTemplateUid: crypto.randomUUID() },
    ];
  if (fault === "duplicate snapshot") evidence.paused.actor.status.snapshots = [snapshot, snapshot];
  if (fault === "foreign snapshot URI" || fault === "unconfirmed snapshot URI")
    evidence.paused.actor.status.snapshots = [
      {
        ...snapshot,
        durableSnapshot: {
          ...snapshot.durableSnapshot,
          object: {
            snapshotUri:
              fault === "foreign snapshot URI"
                ? `s3://owned/atespaces/foreign/actors/${crypto.randomUUID()}/snapshots/${snapshot.uuid}`
                : `${snapshot.durableSnapshot.object.snapshotUri}?unconfirmed=other`,
          },
        },
      },
    ];
  if (fault === "fidelity label only")
    evidence.paused.actor.status.snapshots = [
      { ...snapshot, fidelity: "SNAPSHOT_FIDELITY_ROOTFS" },
    ];
  if (fault === "replayed compiler")
    evidence.after.compiler.commandID = evidence.before.compiler.commandID;
  if (fault === "replayed probe")
    evidence.after.process.challenge = evidence.before.process.challenge;
  if (fault === "ROOTFS process not restarted")
    evidence.after.process.memoryNonce = evidence.before.process.memoryNonce;
  if (fault === "ROOTFS instance not restarted")
    evidence.after.process.instanceID = evidence.before.process.instanceID;
  if (fault === "ROOTFS sandbox not rebooted")
    evidence.after.process.bootID = evidence.before.process.bootID;
  expect(() => requireStarterRetainedLifecycleEvidence(evidence)).toThrow();
});

test("current file access explicitly selects the existing native container demand owner", async () => {
  const f = controlledClient(() =>
    response({ content: "current checkout", version: "current-version", nextOffset: null }),
  );
  const current = await starterNativeLifecycle(f.client).currentFile(
    workspaceID,
    "/workspace/project/src/db/schema.ts",
  );
  expect(current.content).toBe("current checkout");
  expect(f.timeouts).toEqual([nativeLifecycleWindowMS + 30_000]);
  expect(f.calls).toEqual([
    {
      name: "readFile",
      arguments: {
        workspaceID,
        path: "/workspace/project/src/db/schema.ts",
        location: "container",
        limit: 16384,
      },
    },
  ]);
});

test("compiler/tests are one finite authenticated command with real native output", async () => {
  let id: unknown;
  const f = controlledClient((input) => {
    if (input.name === "runCommand") {
      id = input.arguments?.["requestID"];
      return response(commandView(id));
    }
    return response(commandPage(id));
  });
  const result = await starterNativeLifecycle(f.client).command({
    workspaceID,
    attemptID,
    command: "npm run check",
  });
  expect(f.calls.map((call) => call.name)).toEqual(["runCommand", "readCommandOutput"]);
  expect(f.calls[0]?.arguments).toMatchObject({
    requestID: result.commandID,
    workspaceID,
    env: {},
    command: "timeout --signal=TERM --kill-after=5s 300s /bin/sh -ec 'npm run check'",
  });
  expect(result).toMatchObject({ attemptID, state: "exited", exitCode: 0 });
  expect(result.stdout).toBe("native compiler/tests completed");
});

test("native command output advances byte cursors without replaying execution", async () => {
  let id: unknown;
  let reads = 0;
  const f = controlledClient((input) => {
    if (input.name === "runCommand") {
      id = input.arguments?.["requestID"];
      return response(commandView(id));
    }
    reads++;
    return response(
      commandPage(id, {
        state: reads === 1 ? "running" : "exited",
        exitCode: reads === 1 ? null : 0,
        stdout: reads === 1 ? "first-" : "second",
        stdoutFrom: reads === 1 ? 0 : 6,
        stdoutNext: reads === 1 ? 6 : 12,
      }),
    );
  });
  const result = await starterNativeLifecycle(f.client).command({
    workspaceID,
    attemptID,
    command: "printf 'first-second'",
  });
  expect(result.stdout).toBe("first-second");
  expect(f.calls.filter((call) => call.name === "runCommand")).toHaveLength(1);
  expect(f.calls.at(-1)?.arguments).toMatchObject({ stdout: 6, stderr: 0 });
});

test.each([
  { outputAvailable: false },
  { outputLost: true },
  { attemptID: crypto.randomUUID() },
  { stdoutFrom: 1 },
])("unavailable, lost or foreign output never qualifies command success: %j", async (extra) => {
  let id: unknown;
  const f = controlledClient((input) => {
    if (input.name === "runCommand") {
      id = input.arguments?.["requestID"];
      return response(commandView(id));
    }
    return response(
      input.name === "cancelCommand" ? commandView(id, "cancelled") : commandPage(id, extra),
    );
  });
  await expect(
    starterNativeLifecycle(f.client).command({ workspaceID, attemptID, command: "npm run check" }),
  ).rejects.toThrow();
  expect(f.calls.filter((call) => call.name === "runCommand")).toHaveLength(1);
  expect(f.calls.at(-1)).toMatchObject({
    name: "cancelCommand",
    arguments: { commandID: id },
  });
});

test("nonzero compiler/test exit remains failed, never cancelled or replayed to green", async () => {
  let id: unknown;
  const f = controlledClient((input) => {
    if (input.name === "runCommand") {
      id = input.arguments?.["requestID"];
      return response(commandView(id));
    }
    return response(commandPage(id, { exitCode: 1 }));
  });
  await expect(
    starterNativeLifecycle(f.client).command({ workspaceID, attemptID, command: "npm run check" }),
  ).rejects.toThrow();
  expect(f.calls.map((call) => call.name)).toEqual(["runCommand", "readCommandOutput"]);
});

test("destructively stopped compute still requires explicit Start, unlike retained Pause", async () => {
  const failure = {
    error: {
      code: "conflict",
      message: "Start this Workspace explicitly before accessing compute",
    },
  };
  const f = controlledClient((input) =>
    response(
      input.name === "cancelCommand"
        ? { error: { code: "not-found", message: "Command not found" } }
        : failure,
      true,
    ),
  );
  await expect(
    starterNativeLifecycle(f.client).command({ workspaceID, attemptID, command: "npm run check" }),
  ).rejects.toMatchObject(failure.error);
  expect(f.calls.map((call) => call.name)).toEqual(["runCommand", "cancelCommand"]);
});

test("uncertain command admission cancels only that owned ID and is never retried", async () => {
  let id: unknown;
  const f = controlledClient((input) => {
    if (input.name === "runCommand") {
      id = input.arguments?.["requestID"];
      return response(commandView(id, "uncertain"));
    }
    return response(commandView(id, "cancelled"));
  });
  await expect(
    starterNativeLifecycle(f.client).command({ workspaceID, attemptID, command: "npm run check" }),
  ).rejects.toThrow("uncertain");
  expect(f.calls.map((call) => call.name)).toEqual(["runCommand", "cancelCommand"]);
});

test("lost admission reply still cancels the exact remote command ID without replay", async () => {
  let id: unknown;
  const f = controlledClient((input) => {
    if (input.name === "runCommand") {
      id = input.arguments?.["requestID"];
      throw Error("Owned admission reply was lost after remote dispatch");
    }
    return response(commandView(id, "cancelled"));
  });
  await expect(
    starterNativeLifecycle(f.client).command({ workspaceID, attemptID, command: "npm run check" }),
  ).rejects.toThrow("admission reply was lost");
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toMatchObject({ name: "cancelCommand", arguments: { commandID: id } });
});

test("asynchronous exact-command cancellation observes its outcome without restarting compute", async () => {
  let id: unknown;
  const f = controlledClient((input) => {
    if (input.name === "runCommand") {
      id = input.arguments?.["requestID"];
      throw Error("Owned admission reply was lost after remote dispatch");
    }
    return response(commandView(id, input.name === "cancelCommand" ? "running" : "cancelled"));
  });
  await expect(
    starterNativeLifecycle(f.client).command({ workspaceID, attemptID, command: "npm run check" }),
  ).rejects.toThrow("admission reply was lost");
  expect(f.calls.map((call) => call.name)).toEqual(["runCommand", "cancelCommand", "getCommand"]);
  expect(f.calls.at(-1)?.arguments).toEqual({ commandID: id });
});

test("an unavailable exact-command cancellation retains both original and cleanup failures", async () => {
  const lost = Error("Owned admission reply was lost");
  const f = controlledClient((input) => {
    if (input.name === "runCommand") throw lost;
    return response(
      { error: { code: "unavailable", message: "Native command outcome is unconfirmed" } },
      true,
    );
  });
  try {
    await starterNativeLifecycle(f.client).command({
      workspaceID,
      attemptID,
      command: "npm run check",
    });
    throw Error("Unconfirmed cancellation must fail");
  } catch (cause) {
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toMatchObject([
      lost,
      { code: "unavailable", message: "Native command outcome is unconfirmed" },
    ]);
  }
  expect(f.calls.map((call) => call.name)).toEqual(["runCommand", "cancelCommand"]);
});
