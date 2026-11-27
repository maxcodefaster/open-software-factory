import { expect, test } from "bun:test";
import { runtimeIdentity } from "#runtime-domain/identity";
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
      SELECT attempt.state,attempt.atespace,attempt.actor_uid,
        attempt.create_attempted_at,(environment.payload->>'version')::float8 AS version
      FROM factory.runtime_attempt attempt
      JOIN factory.operation environment ON environment.kind='runtime.environment_intent'
        AND environment.scope_type='runtime_attempt'
        AND environment.scope_id=attempt.id::text
        AND environment.idempotency_key='runtime.environment_intent:' || attempt.id::text
      WHERE attempt.id=${attemptID} AND attempt.atespace IS NOT NULL`;
    expect(saved).toMatchObject({
      state: "ready",
      atespace: `fa-${attemptID.replaceAll("-", "")}`,
      actor_uid: null,
      create_attempted_at: null,
      version: 0,
    });
    await expect(
      f.database
        .client`UPDATE factory.runtime_attempt SET binding_intent='{}' WHERE id=${attemptID}`.execute(),
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
