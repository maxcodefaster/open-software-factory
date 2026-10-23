import { expect, test } from "bun:test";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import {
  WriterActivity,
  writerIdleMilliseconds,
} from "../../apps/factory/src/access/writer-activity";
import { workspaceWriteAuthorityIn } from "../../apps/factory/src/access/change-writer";
import { fixture } from "../fixtures/change-agent-turns";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { buildModelID } from "../fixtures/change-agent-turns";

test("shared editing requires a decision, fences the old writer, and never transfers unsaved buffers", async () => {
  const owned = await fixture();
  const ben = crypto.randomUUID();
  let now = 0;
  const activity = new WriterActivity(() => now);
  let stopped = true;
  const effects: string[] = [];
  const writers = createChangeWriterController({
    database: owned.database,
    agentUsername: "owned-agent",
    activity,
    stopDeadlineMs: 1,
    runtime: {
      stop: async () => {
        effects.push("stop");
      },
      get: async () => ({ state: stopped ? "stopped" : "stopping" }),
    },
    stopAgent: async () => {
      effects.push("stop-agent");
    },
    fenceSource: async (_id, _epoch, writable) => {
      effects.push(`source:${writable}`);
    },
    protect: async (_id, users) => {
      effects.push(`git:${users.join(",")}`);
    },
  });
  try {
    await owned.database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${ben},'Ben',${`editing-${ben}@factory.local`},true)`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${owned.projectID},${ben},'developer',${owned.userID})`;
      await sql`UPDATE factory.change_writer SET state='human',user_id=${owned.userID},turn_id=NULL
        WHERE change_id=${owned.changeID}`;
    });
    const first = await writers.status(owned.changeID, owned.userID);
    await writers.activity(owned.changeID, owned.userID, first.epoch, "edit");
    await expect(
      createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, ben, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Do not take another person's editing through the Agent",
      }),
    ).rejects.toThrow("holds editing");
    expect((await writers.status(owned.changeID, owned.userID)).epoch).toBe(first.epoch);
    await expect(writers.takeOver(owned.changeID, ben, crypto.randomUUID())).rejects.toThrow(
      "Another developer",
    );
    await expect(
      writers.takeIdle(owned.changeID, ben, crypto.randomUUID(), first.epoch),
    ).rejects.toThrow("active or changed");
    expect(effects).toEqual([]);
    const requestID = crypto.randomUUID();
    await writers.request(owned.changeID, ben, requestID, first.epoch);
    await writers.request(owned.changeID, ben, requestID, first.epoch);
    expect((await writers.status(owned.changeID, owned.userID)).requests).toMatchObject([
      { id: requestID, requester: { id: ben, name: "Ben" } },
    ]);
    const accepted = await writers.approve(
      owned.changeID,
      owned.userID,
      crypto.randomUUID(),
      requestID,
      first.epoch,
    );
    expect(accepted.canWrite).toBe(false);
    expect((await writers.status(owned.changeID, ben)).canWrite).toBe(true);
    expect(effects).toEqual(["source:false", "git:", "stop", expect.stringContaining("git:")]);
    const [workspace] = await owned.database.client<{ id: string }[]>`
      SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`;
    if (!workspace) throw new Error("Owned Workspace missing");
    await expect(
      owned.database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspace.id, owned.userID),
      ),
    ).rejects.toThrow("observation-only");
    await expect(
      writers.activity(owned.changeID, owned.userID, first.epoch, "edit"),
    ).rejects.toThrow("changed");
    const current = await writers.status(owned.changeID, ben);
    await writers.activity(owned.changeID, ben, current.epoch, "edit");
    now += writerIdleMilliseconds;
    await writers.activity(owned.changeID, ben, current.epoch, "heartbeat");
    expect((await writers.status(owned.changeID, owned.userID)).presence?.idle).toBe(true);
    expect((await writers.status(owned.changeID, ben)).canWrite).toBe(true);
    const taken = await writers.takeIdle(
      owned.changeID,
      owned.userID,
      crypto.randomUUID(),
      current.epoch,
    );
    expect(taken.canWrite).toBe(true);
    await expect(
      writers.takeIdle(owned.changeID, ben, crypto.randomUUID(), current.epoch),
    ).rejects.toThrow();
    const releaseID = crypto.randomUUID();
    stopped = false;
    await expect(
      writers.release(owned.changeID, owned.userID, releaseID, taken.epoch),
    ).rejects.toThrow("Release saved");
    const releasing = await writers.status(owned.changeID, ben);
    expect(releasing).toMatchObject({ state: "handoff", handoffKind: "release", canWrite: false });
    await expect(writers.takeOver(owned.changeID, ben, crypto.randomUUID())).rejects.toThrow(
      "already in progress",
    );
    stopped = true;
    expect(
      (await writers.release(owned.changeID, owned.userID, releaseID, taken.epoch)).state,
    ).toBe("unassigned");
    expect(
      (await writers.release(owned.changeID, owned.userID, releaseID, taken.epoch)).state,
    ).toBe("unassigned");
    expect((await writers.takeOver(owned.changeID, ben, crypto.randomUUID())).canWrite).toBe(true);
    expect(owned.requests()).toBe(0);
    const decisions = await owned.database.client<{ kind: string }[]>`
      SELECT kind FROM factory.change_editing_decision WHERE change_id=${owned.changeID} ORDER BY created_at`;
    expect(decisions.map((row) => row.kind)).toEqual([
      "approve",
      "idle-takeover",
      "release",
      "takeover",
    ]);
    const beforeAgent = await writers.status(owned.changeID, ben);
    await createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, ben, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    const effectsBeforeStale = effects.length;
    now += 24 * 60 * 60_000;
    expect((await writers.status(owned.changeID, owned.userID)).presence).toBeNull();
    await expect(
      writers.takeIdle(owned.changeID, owned.userID, crypto.randomUUID(), beforeAgent.epoch),
    ).rejects.toThrow("only");
    await expect(
      writers.takeOver(
        owned.changeID,
        owned.userID,
        crypto.randomUUID(),
        undefined,
        undefined,
        beforeAgent.epoch,
      ),
    ).rejects.toThrow("writer changed");
    expect(effects.length).toBe(effectsBeforeStale);
  } finally {
    await owned.dispose();
  }
});
