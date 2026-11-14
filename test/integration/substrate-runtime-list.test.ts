import { expect, test } from "bun:test";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";

test("Runtime inventory reads recorded state without native liveness claims or an Actor RPC", async () => {
  const f = await nativeRuntimeFixture();
  try {
    const runtime = f.controller();
    const started = await runtime.start(f.projectID, f.userID);
    if (!started?.native?.actorUID) throw Error("The native owner did not bind its original Actor");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${started.id}`;
    const [before] = await f.database.client`SELECT attempt.*,binding.observation
      FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding
        ON binding.runtime_attempt_id=attempt.id WHERE attempt.id=${started.id}`;
    const calls = f.calls.length;
    f.beforeCall(async () => {
      throw Error("Owned native observation is unavailable");
    });
    const rows = await runtime.list(f.projectID, f.userID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: started.id,
      projectId: f.projectID,
      workspaceId: f.workspaceID,
      state: "ready",
    });
    // Recorded ready is product history, not current Actor or Connector health.
    expect(rows[0]).not.toHaveProperty("native");
    expect(f.calls).toHaveLength(calls);
    const stranger = crypto.randomUUID();
    await f.database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${stranger},'Owned non-member',${`${stranger}@factory.invalid`})`;
    expect(await runtime.list(f.projectID, stranger)).toEqual([]);
    expect(await runtime.list(undefined, stranger)).toEqual([]);
    expect(f.calls).toHaveLength(calls);
    expect(
      (
        await f.database.client`SELECT attempt.*,binding.observation
      FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding
        ON binding.runtime_attempt_id=attempt.id WHERE attempt.id=${started.id}`
      )[0],
    ).toEqual(before);
    // An explicit live observation still needs its real owner and RPC result.
    await expect(runtime.get(started.id)).rejects.toThrow(
      "Owned native observation is unavailable",
    );
    expect(f.calls.length).toBeGreaterThan(calls);
  } finally {
    await f.dispose();
  }
}, 60_000);
