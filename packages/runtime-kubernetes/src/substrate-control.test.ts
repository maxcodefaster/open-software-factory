import { expect, spyOn, test } from "bun:test";
import { createSubstrateControl, nativeActor, nativeSnapshot } from "./substrate-control";

const snapshot = nativeSnapshot.parse({
  uuid: crypto.randomUUID(),
  generation: 1,
  owner: "SNAPSHOT_OWNER_ACTOR",
  fidelity: "SNAPSHOT_FIDELITY_MEMORY",
  actorTemplateUid: crypto.randomUUID(),
  sandboxRuntime: {
    sandboxClass: "gvisor",
    version: {
      schemaVersion: "v1",
      attributes: [{ key: "architecture", value: "amd64" }],
    },
  },
  durableSnapshot: {
    state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
    object: { snapshotUri: "s3://owned/snapshot" },
  },
});

test("native observation retains node pinning after worker assignment is released", () => {
  const actor = nativeActor.parse({
    metadata: {
      uid: crypto.randomUUID(),
      name: "owned",
      atespace: "owned",
      version: "2",
      createTime: "2026-11-25T00:00:00.000Z",
    },
    actorTemplate: { atespace: "owned", name: "runtime" },
    status: {
      state: "ACTOR_STATE_SUSPENDED",
      assignedNode: "owned-worker-node",
      snapshots: [snapshot],
    },
  });
  expect(actor.status).toMatchObject({ assignedNode: "owned-worker-node" });
  expect(actor.status.workerAssignment).toBeUndefined();
});

test.each(["SNAPSHOT_FIDELITY_ROOTFS", "SNAPSHOT_FIDELITY_MEMORY"])(
  "native snapshot accepts a completed durable %s without changing its identity",
  (fidelity) => {
    const candidate = { ...snapshot, fidelity };
    expect(nativeSnapshot.parse(candidate)).toEqual(candidate);
  },
);

test.each([
  "SNAPSHOT_FIDELITY_UNKNOWN",
  "SNAPSHOT_FIDELITY_FILESYSTEM",
  "UNKNOWN",
  "FILESYSTEM",
  "MEMORY",
  "",
  null,
  undefined,
])("native snapshot rejects unsupported fidelity %s", (fidelity) => {
  expect(nativeSnapshot.safeParse({ ...snapshot, fidelity }).success).toBe(false);
});

test.each([
  ["missing durable snapshot", { ...snapshot, durableSnapshot: undefined }],
  ["null durable snapshot", { ...snapshot, durableSnapshot: null }],
  [
    "pending durable snapshot",
    {
      ...snapshot,
      durableSnapshot: { ...snapshot.durableSnapshot, state: "SNAPSHOT_STORAGE_STATE_PENDING" },
    },
  ],
  [
    "failed durable snapshot",
    {
      ...snapshot,
      durableSnapshot: { ...snapshot.durableSnapshot, state: "SNAPSHOT_STORAGE_STATE_FAILED" },
    },
  ],
  [
    "completed without object",
    { ...snapshot, durableSnapshot: { state: "SNAPSHOT_STORAGE_STATE_COMPLETED" } },
  ],
  [
    "completed without URI",
    { ...snapshot, durableSnapshot: { ...snapshot.durableSnapshot, object: {} } },
  ],
  [
    "empty URI",
    { ...snapshot, durableSnapshot: { ...snapshot.durableSnapshot, object: { snapshotUri: "" } } },
  ],
  ["invalid UUID", { ...snapshot, uuid: "not-a-uuid" }],
  ["invalid template UUID", { ...snapshot, actorTemplateUid: "not-a-uuid" }],
  ["missing UUID", { ...snapshot, uuid: undefined }],
  ["zero generation", { ...snapshot, generation: 0 }],
  ["negative generation", { ...snapshot, generation: -1 }],
  ["fractional generation", { ...snapshot, generation: 1.5 }],
  ["string generation", { ...snapshot, generation: "1" }],
  ["unsafe generation", { ...snapshot, generation: Number.MAX_SAFE_INTEGER + 1 }],
  ["non-Actor owner", { ...snapshot, owner: "SNAPSHOT_OWNER_UNKNOWN" }],
  ["missing runtime", { ...snapshot, sandboxRuntime: undefined }],
  [
    "wrong sandbox class",
    { ...snapshot, sandboxRuntime: { ...snapshot.sandboxRuntime, sandboxClass: "other" } },
  ],
  [
    "wrong runtime schema",
    {
      ...snapshot,
      sandboxRuntime: {
        ...snapshot.sandboxRuntime,
        version: { ...snapshot.sandboxRuntime.version, schemaVersion: "v2" },
      },
    },
  ],
  [
    "empty runtime identity",
    {
      ...snapshot,
      sandboxRuntime: {
        ...snapshot.sandboxRuntime,
        version: { ...snapshot.sandboxRuntime.version, attributes: [] },
      },
    },
  ],
])("native MEMORY snapshot rejects %s", (_description, candidate) => {
  expect(nativeSnapshot.safeParse(candidate).success).toBe(false);
});

test("native lifecycle bridge waits for Substrate finalization while reads keep their existing process bound", async () => {
  let options: { timeout?: number; env?: Record<string, string | undefined> } | undefined;
  const spawn = spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
    options = args[1] as typeof options;
    return {
      stdout: new Response("{}").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>;
  });
  try {
    const call = createSubstrateControl({
      bridge: "/owned/bridge",
      endpoint: "127.0.0.1:1",
      serverName: "api.ate-system.svc",
      caFile: "/owned/ca",
      tokenFile: "/owned/token",
    });
    for (const method of [
      "ResumeActor",
      "SuspendActor",
      "GetActor",
      "CreateActor",
      "DeleteActor",
    ]) {
      await call(method, {});
      expect(options?.timeout).toBe(
        method === "ResumeActor" || method === "SuspendActor" ? 0 : 185_000,
      );
      expect(Object.keys(options?.env ?? {})).toEqual(["PATH"]);
    }
  } finally {
    spawn.mockRestore();
  }
});
