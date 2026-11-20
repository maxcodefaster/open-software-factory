import { expect, test } from "bun:test";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
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
    expect(rows[0]?.generation).toBe("1");
    expect(typeof rows[0]?.createdAt).toBe("string");
    expect(typeof rows[0]?.updatedAt).toBe("string");
    expect((await runtime.list(undefined, f.userID)).map((row) => row.id)).toEqual([started.id]);
    expect(f.calls).toHaveLength(calls);
    const stranger = crypto.randomUUID();
    await f.database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${stranger},'Owned non-member',${`${stranger}@factory.invalid`})`;
    expect(await runtime.list(f.projectID, stranger)).toEqual([]);
    expect(await runtime.list(undefined, stranger)).toEqual([]);
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${stranger},'developer',${f.userID})`;
    expect(await runtime.list(f.projectID, stranger)).toEqual([]);
    const sharing = createWorkspaceSharing(f.database, () => {});
    await sharing.decide(f.userID, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: stranger,
      permission: "observe",
      expectedVersion: 0,
    });
    expect((await runtime.list(f.projectID, stranger)).map((row) => row.id)).toEqual([started.id]);
    await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
      WHERE project_id=${f.projectID} AND user_id=${stranger}`;
    expect(await runtime.list(f.projectID, stranger)).toEqual([]);
    await f.database.client`UPDATE factory.project_membership SET role='developer'
      WHERE project_id=${f.projectID} AND user_id=${stranger}`;
    await sharing.decide(f.userID, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: stranger,
      permission: null,
      expectedVersion: 1,
    });
    expect(await runtime.list(f.projectID, stranger)).toEqual([]);
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
    await removeRuntimeRepository(f.attemptID);
    await f.dispose();
  }
}, 60_000);

test("Runtime process and terminal commands retain unknown replies without redispatch", async () => {
  const f = await nativeRuntimeFixture();
  try {
    const runtime = f.controller();
    const started = await runtime.start(f.projectID, f.userID);
    if (!started) throw Error("Owned Workspace did not start");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${started.id}`;
    let processes = 0,
      terminals = 0;
    f.hub.hasAppChannel = () => true;
    f.hub.childRequest = async () => {
      processes++;
      throw Error("owned unknown process reply");
    };
    f.hub.childOperation = async () => {
      terminals++;
      throw Error("owned unknown terminal reply");
    };
    await expect(runtime.processAction(started.id, "app", "restart")).rejects.toThrow(
      "owned unknown process reply",
    );
    await expect(runtime.closeTerminal(started.id, "owned-terminal")).rejects.toThrow(
      "owned unknown terminal reply",
    );
    await expect(runtime.closeTerminal(started.id, "invalid/terminal")).rejects.toThrow(
      "Terminal session is invalid",
    );
    expect(processes).toBe(1);
    expect(terminals).toBe(1);
  } finally {
    await removeRuntimeRepository(f.attemptID);
    await f.dispose();
  }
}, 60_000);
