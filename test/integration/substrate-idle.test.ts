import { expect, test } from "bun:test";
import { createIdleCompute } from "../../apps/factory/src/runtime/idle";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

test("native idle records Pause under the Workspace lock and never converts snapshot history into Stop", async () => {
  const f = await substrateFixture();
  let idle: ReturnType<typeof createIdleCompute> | undefined;
  try {
    await startSubstrateFixtureWorkspace(f);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
    // A native snapshot ordinal is not a Factorybox lifecycle-record limit.
    await f.database.client`UPDATE factory.substrate_binding SET
      observation=jsonb_set(observation,'{status,lastAssignedGeneration}','99'::jsonb)
      WHERE runtime_attempt_id=${f.attemptID}`;
    let pauses = 0;
    idle = createIdleCompute(
      f.database,
      { claimIdle: () => true, releaseIdle: () => {} },
      {
        async pause(attemptID) {
          expect(attemptID).toBe(f.attemptID);
          const [intent] = await f.database.client`
          SELECT state,stop_intended_at FROM factory.runtime_attempt WHERE id=${attemptID}`;
          expect(intent?.["state"]).toBe("pausing");
          expect(intent?.["stop_intended_at"]).toBeNull();
          pauses++;
        },
      },
      1,
      1,
      0,
    );
    await Promise.all([idle.sweep(), idle.sweep()]);
    expect(pauses).toBe(1);
    const [source] = await f.database.client`SELECT id,source_revision,owner_user_id
      FROM factory.development_workspace WHERE id=${f.workspaceID}`;
    expect(source?.["source_revision"]).toBe("a".repeat(40));
    expect(source?.["owner_user_id"]).toBe(f.userID);
    expect(
      (
        await f.database.client`SELECT deleted_at FROM factory.substrate_binding
      WHERE runtime_attempt_id=${f.attemptID}`
      )[0]?.["deleted_at"],
    ).toBeNull();
  } finally {
    await idle?.close();
    await f.dispose();
  }
}, 60_000);
