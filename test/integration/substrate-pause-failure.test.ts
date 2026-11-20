import { expect, test } from "bun:test";
import { SubstrateRPCError } from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test("native Pause retains a bounded control-free failure without discarding Source, replacing the Actor or repeating an uncertain checkpoint", async () => {
  const f = await substrateFixture();
  let actor: ReturnType<typeof f.actor> | undefined;
  let creates = 0,
    suspends = 0,
    deletes = 0;
  const nativeError = new SubstrateRPCError(
    "Unavailable",
    `\u001b[31mnative\0 checkpoint\u0007 failed\n${"x".repeat(2500)}\u001b[0m`,
  );
  const runtime = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      creates++;
      actor = await f.createdActor();
      return structuredClone(actor);
    }
    if (method === "ResumeActor" && actor) {
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    if (method === "SuspendActor" && actor) {
      suspends++;
      actor.metadata.version = "3";
      actor.status.state = "ACTOR_STATE_SUSPENDING";
      actor.status.lastAssignedGeneration = 2;
      actor.status.snapshots = [
        {
          uuid: crypto.randomUUID(),
          generation: 2,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: f.config.templateUID,
          sandboxRuntime: f.config.runtime,
          durableSnapshot: { state: "SNAPSHOT_STORAGE_STATE_PENDING" },
        },
      ];
      throw nativeError;
    }
    if (method === "DeleteActor") deletes++;
    throw new Error(`Unexpected controlled native operation ${method}`);
  });
  try {
    await runtime.start(f.projectID, f.userID);
    const originalUID = actor?.metadata.uid;
    const originalWorkspace = await f.database.client`SELECT * FROM factory.development_workspace`;
    await expect(runtime.pause(f.attemptID)).rejects.toBe(nativeError);
    const [saved] = await f.database.client<{ state: string; failure: string }[]>`
      SELECT state,failure FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(saved?.state).toBe("pausing");
    expect(saved?.failure).toStartWith("native checkpoint failed ");
    expect(saved?.failure.length).toBe(2000);
    expect(saved?.failure).not.toContain("\0");
    expect(saved?.failure).not.toContain("\u0007");
    expect(saved?.failure).not.toContain("\u001b");
    await expect(runtime.pause(f.attemptID)).rejects.toThrow("no operation was repeated");
    const [binding] = await f.database.client<
      { uid: string; checkpoint: unknown; deleting: unknown }[]
    >`
      SELECT actor_uid AS uid,checkpoint,delete_intended_at AS deleting
      FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
    expect(binding?.uid).toBe(originalUID);
    expect(binding?.checkpoint).toBeNull();
    expect(binding?.deleting).toBeNull();
    expect(await f.database.client`SELECT * FROM factory.development_workspace`).toEqual(
      originalWorkspace,
    );
    expect({ creates, suspends, deletes }).toEqual({ creates: 1, suspends: 1, deletes: 0 });
  } finally {
    await f.dispose();
  }
}, 60_000);
