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
import { createWriterService } from "../../apps/factory/src/access/writer-service";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { writerViewSchema } from "../../apps/factory/src/api-contracts";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";

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
  const origin = "https://owned-editing.test";
  const endpoint = await compiledFactoryEndpoint({
    origin,
    services: {
      writer: createWriterService(writers, createAccessController(owned.database)),
    } as FactoryServices,
    session: async (request) => {
      const actor = request.headers.get("x-owned-actor");
      return actor === owned.userID || actor === ben ? { user: { id: actor } } : null;
    },
    maintenance: async () => false,
    requireFresh: async () => {},
  });
  async function native(userID: string, name: string, args: unknown[]) {
    const response = await endpoint(
      await factoryFunctionRequest(origin, name, args, { "x-owned-actor": userID }),
    );
    const result = await decodeResponse<ServerResult<unknown>>(response);
    if (!result) throw new Error("Owned native editing command returned no result");
    return serverCall(Promise.resolve(result as ServerResult<unknown>));
  }
  const status = async (userID: string) =>
    writerViewSchema.parse(await native(userID, "getChangeWriterStatus", [owned.changeID]));
  try {
    await owned.database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${ben},'Ben',${`editing-${ben}@factory.local`},true)`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${owned.projectID},${ben},'developer',${owned.userID})`;
      await sql`UPDATE factory.change_writer SET state='human',user_id=${owned.userID},turn_id=NULL
        WHERE change_id=${owned.changeID}`;
    });
    const first = await status(owned.userID);
    await native(owned.userID, "recordChangeEditingActivity", [
      owned.changeID,
      { epoch: first.epoch, kind: "edit" },
    ]);
    await expect(
      createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, ben, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Do not take another person's editing through the Agent",
      }),
    ).rejects.toThrow("holds editing");
    expect((await status(owned.userID)).epoch).toBe(first.epoch);
    await expect(writers.takeOver(owned.changeID, ben, crypto.randomUUID())).rejects.toThrow(
      "Another developer",
    );
    await expect(
      native(ben, "takeOverIdleEditing", [
        owned.changeID,
        { commandID: crypto.randomUUID(), epoch: first.epoch },
      ]),
    ).rejects.toThrow("active or changed");
    expect(effects).toEqual([]);
    const requestID = crypto.randomUUID();
    await native(ben, "requestChangeEditing", [
      owned.changeID,
      { commandID: requestID, epoch: first.epoch },
    ]);
    await native(ben, "requestChangeEditing", [
      owned.changeID,
      { commandID: requestID, epoch: first.epoch },
    ]);
    expect((await status(owned.userID)).requests).toMatchObject([
      { id: requestID, requester: { id: ben, name: "Ben" } },
    ]);
    const accepted = writerViewSchema.parse(
      await native(owned.userID, "approveChangeEditing", [
        owned.changeID,
        { commandID: crypto.randomUUID(), requestID, epoch: first.epoch },
      ]),
    );
    expect(accepted.canWrite).toBe(false);
    expect((await status(ben)).canWrite).toBe(true);
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
      native(owned.userID, "recordChangeEditingActivity", [
        owned.changeID,
        { epoch: first.epoch, kind: "edit" },
      ]),
    ).rejects.toThrow("changed");
    const current = await status(ben);
    await native(ben, "recordChangeEditingActivity", [
      owned.changeID,
      { epoch: current.epoch, kind: "edit" },
    ]);
    now += writerIdleMilliseconds;
    await native(ben, "recordChangeEditingActivity", [
      owned.changeID,
      { epoch: current.epoch, kind: "heartbeat" },
    ]);
    expect((await status(owned.userID)).presence?.idle).toBe(true);
    expect((await status(ben)).canWrite).toBe(true);
    const taken = writerViewSchema.parse(
      await native(owned.userID, "takeOverIdleEditing", [
        owned.changeID,
        { commandID: crypto.randomUUID(), epoch: current.epoch },
      ]),
    );
    expect(taken.canWrite).toBe(true);
    await expect(
      native(ben, "takeOverIdleEditing", [
        owned.changeID,
        { commandID: crypto.randomUUID(), epoch: current.epoch },
      ]),
    ).rejects.toThrow();
    const releaseID = crypto.randomUUID();
    stopped = false;
    await expect(
      native(owned.userID, "releaseChangeEditing", [
        owned.changeID,
        { commandID: releaseID, epoch: taken.epoch },
      ]),
    ).rejects.toThrow("Release saved");
    const releasing = await status(ben);
    expect(releasing).toMatchObject({ state: "handoff", handoffKind: "release", canWrite: false });
    await expect(writers.takeOver(owned.changeID, ben, crypto.randomUUID())).rejects.toThrow(
      "already in progress",
    );
    stopped = true;
    expect(
      writerViewSchema.parse(
        await native(owned.userID, "releaseChangeEditing", [
          owned.changeID,
          { commandID: releaseID, epoch: taken.epoch },
        ]),
      ).state,
    ).toBe("unassigned");
    expect(
      writerViewSchema.parse(
        await native(owned.userID, "releaseChangeEditing", [
          owned.changeID,
          { commandID: releaseID, epoch: taken.epoch },
        ]),
      ).state,
    ).toBe("unassigned");
    const available = await status(ben);
    expect(
      writerViewSchema.parse(
        await native(ben, "takeOverChangeEditing", [
          owned.changeID,
          { commandID: crypto.randomUUID(), epoch: available.epoch },
        ]),
      ).canWrite,
    ).toBe(true);
    expect(owned.requests()).toBe(0);
    const decisions = await owned.database.client<{ kind: string }[]>`
      SELECT kind FROM factory.change_editing_decision WHERE change_id=${owned.changeID} ORDER BY created_at`;
    expect(decisions.map((row) => row.kind)).toEqual([
      "approve",
      "idle-takeover",
      "release",
      "takeover",
    ]);
    const beforeAgent = await status(ben);
    await createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, ben, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    const effectsBeforeStale = effects.length;
    now += 24 * 60 * 60_000;
    expect((await status(owned.userID)).presence).toBeNull();
    await expect(
      native(owned.userID, "takeOverIdleEditing", [
        owned.changeID,
        { commandID: crypto.randomUUID(), epoch: beforeAgent.epoch },
      ]),
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
