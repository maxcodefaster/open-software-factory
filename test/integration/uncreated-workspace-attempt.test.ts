import { expect, test } from "bun:test";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { substrateFixture } from "../fixtures/substrate";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";

test("controller fixtures retain a deterministic uncreated native binding and immutable environment without dispatching an Actor", async () => {
  const f = await substrateFixture();
  try {
    const attemptID = await recordUncreatedWorkspaceAttempt(f.database, {
      workspaceID: f.workspaceID,
      generation: 1,
      createdBy: f.userID,
      parentHash: "a".repeat(64),
      childHash: "b".repeat(64),
      connectorURL: "wss://owned.factory.invalid/internal/runtime-connect",
    });
    expect(attemptID).toBe(runtimeIdentity(f.workspaceID, 1).attemptID);
    const [saved] = await f.database.client`
      SELECT attempt.state,binding.atespace,binding.actor_uid,
        binding.create_attempted_at,environment.version::float8 AS version
      FROM factory.runtime_attempt attempt
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      JOIN factory.runtime_environment_intent environment ON environment.runtime_attempt_id=attempt.id
      WHERE attempt.id=${attemptID}`;
    expect(saved).toMatchObject({
      state: "ready",
      atespace: `fa-${attemptID.replaceAll("-", "")}`,
      actor_uid: null,
      create_attempted_at: null,
      version: 0,
    });
    await expect(
      f.database
        .client`UPDATE factory.substrate_binding SET intent='{}' WHERE runtime_attempt_id=${attemptID}`.execute(),
    ).rejects.toThrow("immutable");
    await expect(
      f.database
        .client`UPDATE factory.runtime_environment_intent SET version=1 WHERE runtime_attempt_id=${attemptID}`.execute(),
    ).rejects.toThrow("immutable");
    await expect(
      recordUncreatedWorkspaceAttempt(f.database, {
        workspaceID: crypto.randomUUID(),
        generation: 1,
        createdBy: f.userID,
        parentHash: "a".repeat(64),
        childHash: "b".repeat(64),
        connectorURL: "wss://owned.factory.invalid/internal/runtime-connect",
      }),
    ).rejects.toThrow("owned database and Workspace");
    expect(
      await f.database
        .client`SELECT id FROM factory.runtime_attempt WHERE project_id=${f.projectID}`,
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 60_000);
