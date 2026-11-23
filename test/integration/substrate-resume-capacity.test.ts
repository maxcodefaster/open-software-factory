import { expect, test } from "bun:test";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";
import { substrateFixture } from "../fixtures/substrate";

type ResumeFact = {
  actor_uid: string;
  native_version: string;
  origin_key: string;
  origin_checkpoint: unknown;
  attempted_at: string;
  outcome: unknown;
};

async function capacityFixture() {
  const f = await substrateFixture();
  let actor: NativeActor | undefined;
  let failure: Error | undefined;
  let before: ((method: string) => Promise<void>) | undefined;
  let creates = 0;
  let resumes = 0;
  const runtime = await f.controller(async (method) => {
    await before?.(method);
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "Owned Actor absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      creates++;
      actor = await f.createdActor();
      return structuredClone(actor);
    }
    if (method === "ResumeActor" && actor) {
      resumes++;
      if (failure) {
        const cause = failure;
        failure = undefined;
        throw cause;
      }
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        ...actor.status,
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    if (method === "SuspendActor" && actor) {
      const uuid = crypto.randomUUID();
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        state: "ACTOR_STATE_SUSPENDED",
        lastAssignedGeneration: 1,
        snapshots: [
          {
            uuid,
            generation: 1,
            owner: "SNAPSHOT_OWNER_ACTOR",
            fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
            actorTemplateUid: f.config.templateUID,
            sandboxRuntime: f.config.runtime,
            durableSnapshot: {
              state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
              object: {
                snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
              },
            },
          },
        ],
      };
      return { actor: structuredClone(actor) };
    }
    throw Error(`Uncommissioned native operation ${method}`);
  });
  const facts = () =>
    f.database.client<
      ResumeFact[]
    >`SELECT actor_uid::text,native_version,origin_key,origin_checkpoint,
      attempted_at::text,outcome FROM factory.substrate_actor_rpc
      WHERE runtime_attempt_id=${f.attemptID} AND action='resume'
      AND origin_key<>'initial'`;
  return {
    ...f,
    runtime,
    facts,
    currentActor() {
      if (!actor) throw Error("Original controlled Actor is missing");
      return actor;
    },
    rejectNext(cause: Error = new SubstrateRPCError("ResourceExhausted", "no worker has room")) {
      failure = cause;
    },
    beforeCall(callback: (method: string) => Promise<void>) {
      before = callback;
    },
    creates: () => creates,
    resumes: () => resumes,
    wait: async () => [
      ...(await f.database.client`SELECT reason FROM factory.runtime_compute_wait
        WHERE attempt_id=${f.attemptID}`),
    ],
  };
}

test.skipIf(!process.env["FACTORY_TEST_POSTGRES"])(
  "controller fixtures reuse inherited PostgreSQL without sharing databases or daemon ownership",
  async () => {
    const first = await substrateFixture();
    try {
      const second = await substrateFixture();
      try {
        expect(second.config.database).not.toBe(first.config.database);
        const [shared] = await first.database.client<{ name: string }[]>`
          SELECT datname AS name FROM pg_database WHERE datname=${second.config.database}`;
        expect(shared?.name).toBe(second.config.database);
        expect([
          ...(await first.database
            .client`SELECT id FROM factory.project WHERE id=${second.projectID}`),
        ]).toEqual([]);
      } finally {
        await second.dispose();
      }
      expect([
        ...(await first.database
          .client`SELECT id FROM factory.project WHERE id=${first.projectID}`),
      ]).toEqual([{ id: first.projectID }]);
    } finally {
      await first.dispose();
    }
  },
);

test("a capacity-rejected checkpoint Resume can continue without replacing its Actor or dispatch facts", async () => {
  const f = await capacityFixture();
  try {
    await f.runtime.start(f.projectID, f.userID);
    await f.runtime.pause(f.attemptID);
    f.rejectNext();
    await expect(f.runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow(
      "no worker has room",
    );
    const original = await f.facts();
    expect(original).toHaveLength(1);
    expect(original[0]?.outcome).toBeNull();
    expect(
      await f.wait(),
      "a confirmed unassigned capacity rejection must be visible instead of indefinite starting",
    ).toEqual([{ reason: "compute-capacity" }]);
    await f.runtime.resumeForApp(f.attemptID, f.userID);
    const completed = await f.facts();
    expect(completed.map((fact): ResumeFact => ({ ...fact, outcome: null }))).toEqual(original);
    expect(completed[0]?.outcome).toMatchObject({ state: "ACTOR_STATE_RUNNING" });
    expect(f.resumes()).toBe(3);
    expect(f.creates()).toBe(1);
    expect(await f.wait()).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test.each([
  "unknown-reply",
  "uid",
  "create-time",
  "version",
  "assigned",
  "snapshot-uri",
  "snapshot-uuid",
  "snapshot-pending",
  "source-tag",
  "ready",
  "failed",
  "stop",
  "revoked",
  "revoked-during-observation",
  "other-hold",
] as const)(
  "checkpoint capacity continuation refuses %s without another dispatch",
  async (fault) => {
    const f = await capacityFixture();
    try {
      await f.runtime.start(f.projectID, f.userID);
      await f.runtime.pause(f.attemptID);
      if (fault === "unknown-reply") f.rejectNext(new Error("Owned unknown Resume reply"));
      else f.rejectNext();
      await expect(f.runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow();
      expect(await f.wait()).toEqual(
        fault === "unknown-reply" ? [] : [{ reason: "compute-capacity" }],
      );
      const original = await f.facts();
      const actor = f.currentActor();
      const snapshot = actor.status.snapshots?.at(-1) as {
        uuid: string;
        durableSnapshot: { state: string; object: { snapshotUri: string } };
      };
      switch (fault) {
        case "uid":
          actor.metadata.uid = crypto.randomUUID();
          break;
        case "create-time":
          actor.metadata.createTime = "2000-01-01T00:00:00.000Z";
          break;
        case "version":
          actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
          break;
        case "assigned":
          actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
          break;
        case "snapshot-uri":
          snapshot.durableSnapshot.object.snapshotUri =
            snapshot.durableSnapshot.object.snapshotUri.replace("s3://owned/", "s3://other/");
          break;
        case "snapshot-uuid": {
          const replacement = crypto.randomUUID();
          snapshot.durableSnapshot.object.snapshotUri =
            snapshot.durableSnapshot.object.snapshotUri.replace(snapshot.uuid, replacement);
          snapshot.uuid = replacement;
          break;
        }
        case "snapshot-pending":
          snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_PENDING";
          break;
        case "source-tag":
          actor.sourceTag = { name: "foreign-image" };
          break;
        case "ready":
        case "failed":
          await f.database
            .client`UPDATE factory.runtime_attempt SET state=${fault} WHERE id=${f.attemptID}`;
          break;
        case "stop":
          await f.database
            .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${f.attemptID}`;
          break;
        case "revoked":
          await f.database.client`DELETE FROM factory.project_membership
          WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
          break;
        case "revoked-during-observation":
          f.beforeCall(async (method) => {
            if (method === "GetActorTemplate")
              await f.database.client`DELETE FROM factory.project_membership
              WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
          });
          break;
        case "other-hold":
          await f.database.client`UPDATE factory.runtime_compute_wait
          SET reason='accounting-incomplete' WHERE attempt_id=${f.attemptID}`;
          break;
      }
      const continuation = expect(f.runtime.resumeForApp(f.attemptID, f.userID)).rejects;
      if (fault === "create-time")
        await continuation.toThrow("Native Actor differs from its immutable create binding");
      else await continuation.toThrow();
      expect(f.resumes()).toBe(2);
      expect(f.creates()).toBe(1);
      expect(await f.facts()).toEqual(original);
    } finally {
      await f.dispose();
    }
  },
);

test("initial Workspace capacity continuation preserves its independent editable Source seed", async () => {
  const f = await nativeRuntimeFixture();
  const runtime = f.controller();
  let reject = true;
  f.beforeCall(async (method) => {
    if (method === "ResumeActor" && reject) {
      reject = false;
      throw new SubstrateRPCError("ResourceExhausted", "no worker has room");
    }
  });
  try {
    await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("no worker has room");
    const source = () =>
      f.database.client`SELECT * FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`;
    const original = await source();
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({
      owner: "service",
      actor_uid: null,
      writable: true,
      writer_epoch: "1",
      checkpoint_id: null,
      generation: "0",
    });
    await runtime.start(f.projectID, f.userID);
    expect(await source()).toEqual(original);
    expect(f.calls.filter((call) => call.method === "CreateActor")).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "ResumeActor")).toHaveLength(2);
    expect([
      ...(await f.database.client`SELECT reason FROM factory.runtime_compute_wait
          WHERE attempt_id=${f.attemptID}`),
    ]).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("a capacity wait is not reused after an unknown continuation reply", async () => {
  const f = await capacityFixture();
  try {
    await f.runtime.start(f.projectID, f.userID);
    await f.runtime.pause(f.attemptID);
    f.rejectNext();
    await expect(f.runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow(
      "no worker has room",
    );
    const original = await f.facts();
    f.rejectNext(new Error("Owned unknown continuation reply"));
    await expect(f.runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow(
      "Owned unknown continuation reply",
    );
    expect(await f.wait()).toEqual([]);
    await expect(f.runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow("not repeated");
    expect(f.resumes()).toBe(3);
    expect(f.creates()).toBe(1);
    expect(await f.facts()).toEqual(original);
  } finally {
    await f.dispose();
  }
});
