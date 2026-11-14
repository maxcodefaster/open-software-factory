import { expect, test } from "bun:test";
import { drainNativeOperations } from "../../apps/factory/src/runtime/native-lock";
import { admitComputeIn, computeAllocationIn } from "../../apps/factory/src/usage/compute";
import { createUsageService } from "../../apps/factory/src/usage/service";
import { defaultExecutionPolicy } from "../../packages/conversation-domain/src/execution-policy";
import {
  nativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

test.each(
  (["factory", "project"] as const).flatMap((scope) =>
    (["sandboxes", "cpuMilli", "memoryMiB"] as const).map((dimension) => ({
      scope,
      dimension,
    })),
  ),
)(
  "native $scope $dimension allowance retains unresolved cleanup exactly once",
  async ({ scope, dimension }) => {
    const f = await substrateFixture();
    const resources = { cpuMilli: 2250, memoryMiB: 3072 };
    f.config.resources = resources;
    try {
      await startSubstrateFixtureWorkspace(f);
      const policy = {
        ...defaultExecutionPolicy(),
        [dimension]: { sandboxes: 1, ...resources }[dimension],
      };
      const policyScope = scope === "factory" ? "factory" : f.projectID;
      await f.database.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
      VALUES(${policyScope},1,${JSON.stringify(policy)}::jsonb,${f.userID})`;
      const [identity] = await f.database.client`
      SELECT id,generation,revision,parent_connector_token_hash,child_connector_token_hash
      FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
      for (const state of [
        "starting",
        "ready",
        "pausing",
        "paused",
        "resuming",
        "stopping",
        "cleanup-failed",
        "failed",
        "stopped",
      ]) {
        // Product projections, including stopped/failed, do not establish native
        // release. Only an observed exact Delete or unallocated native crash can.
        await f.database.client`UPDATE factory.runtime_attempt SET state=${state}
        WHERE id=${f.attemptID}`;
        expect(await computeAllocationIn(f.database.client, null)).toEqual({
          sandboxes: 1,
          ...resources,
        });
        expect(await computeAllocationIn(f.database.client, f.projectID)).toEqual({
          sandboxes: 1,
          ...resources,
        });
        await expect(
          f.database.client.begin((sql) => admitComputeIn(sql, f.projectID, resources)),
        ).rejects.toThrow("Compute allowance is occupied");
      }
      // Reducing the allowance blocks new admissions without rewriting the
      // admitted native identity or evicting an existing Actor.
      await f.database.client`UPDATE factory.execution_policy
      SET policy=${JSON.stringify({ ...policy, [dimension]: 0 })}::jsonb
      WHERE scope=${policyScope}`;
      await expect(
        f.database.client.begin((sql) => admitComputeIn(sql, f.projectID, resources)),
      ).rejects.toThrow("Compute allowance is occupied");
      expect(
        (
          await f.database.client`
        SELECT id,generation,revision,parent_connector_token_hash,child_connector_token_hash
        FROM factory.runtime_attempt WHERE id=${f.attemptID}`
        )[0],
      ).toEqual(identity);
      expect(
        await f.database.client`SELECT runtime_attempt_id FROM factory.substrate_binding
        WHERE runtime_attempt_id=${f.attemptID} AND deleted_at IS NULL`,
      ).toHaveLength(1);
      expect(
        await f.database.client`SELECT attempt_id FROM factory.runtime_compute_wait`,
      ).toHaveLength(0);
      expect(
        (await f.database.client`SELECT to_regclass('factory.execution_slot') AS slot`)[0],
      ).toEqual({ slot: null });
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("native allowance uses immutable resource intent and unknown failures do not free capacity", async () => {
  const f = await substrateFixture();
  const resources = { cpuMilli: 2250, memoryMiB: 3072 };
  f.config.resources = resources;
  let actor: ReturnType<typeof f.actor> | undefined;
  const runtime = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = f.actor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      actor.metadata.version = "2";
      return { actor };
    }
    if (method === "DeleteActor" && actor) {
      const removed = actor;
      actor = undefined;
      return removed;
    }
    throw new Error(`Unexpected controlled native operation ${method}`);
  });
  try {
    await runtime.start(f.projectID, f.userID);
    const allocation = () => computeAllocationIn(f.database.client, f.projectID);
    expect(await allocation()).toEqual({ sandboxes: 1, ...resources });
    await f.database
      .client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
      VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), sandboxes: 1 })}::text::jsonb,
        'Europe/Berlin',${f.userID})`;
    await expect(
      f.database.client.begin((sql) => admitComputeIn(sql, f.projectID, resources)),
    ).rejects.toThrow("Compute allowance is occupied");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
    expect(await allocation()).toEqual({ sandboxes: 1, ...resources });
    const compute = await createUsageService(f.database).compute(f.userID, f.projectID);
    expect(compute.observations).toHaveLength(1);
    expect(compute.observations[0]).toMatchObject({
      id: f.attemptID,
      status: "unavailable",
      cpuMilli: null,
      memoryMiB: null,
      timestamp: null,
    });
    actor = nativeActor.parse(actor);
    actor.status = { state: "ACTOR_STATE_CRASHED" };
    actor.metadata.version = "3";
    expect((await runtime.get(f.attemptID))?.native?.state).toBe("ACTOR_STATE_CRASHED");
    expect(await allocation()).toEqual({ sandboxes: 0, cpuMilli: 0, memoryMiB: 0 });
    await runtime.stop(f.attemptID);
    expect(
      (await createUsageService(f.database).compute(f.userID, f.projectID)).observations,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("the actual Substrate adapter registers an in-flight Resume for Factory shutdown", async () => {
  const f = await substrateFixture();
  const resumed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let actor: ReturnType<typeof f.actor> | undefined;
  let starting: Promise<unknown> | undefined;
  const runtime = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = f.actor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      resumed.resolve();
      await release.promise;
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      actor.metadata.version = "2";
      return { actor };
    }
    throw new Error(`Unexpected controlled native operation ${method}`);
  });
  try {
    starting = runtime.start(f.projectID, f.userID);
    await resumed.promise;
    expect(await drainNativeOperations(20)).toBe(1);
    release.resolve();
    await starting;
    expect(await drainNativeOperations(1_000)).toBe(0);
  } finally {
    release.resolve();
    await starting?.catch(() => {});
    await f.dispose();
  }
}, 60_000);
