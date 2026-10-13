import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createHash } from "node:crypto";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { fixture } from "../fixtures/change-agent-turns";

async function until(check: () => Promise<boolean>) {
  for (let observation = 0; observation < 100; observation += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Owned commit assertion did not become true");
}

test.each(["Stop", "Requirements", "mode", "generation", "Change"] as const)(
  "a prepared commit cannot push after changed %s authority",
  async (boundary) => {
    const owned = await fixture();
    const controller = owned.controller();
    const prepareEntered = Promise.withResolvers<void>();
    const releasePrepare = Promise.withResolvers<void>();
    const operation = owned.hub.parentOperation.bind(owned.hub);
    owned.hub.parentOperation = async (...args) => {
      const result = await operation(...args);
      if (args[1]["action"] === "git-prepare-commit") {
        prepareEntered.resolve();
        await releasePrepare.promise;
      }
      return result;
    };
    try {
      const conversationID = crypto.randomUUID();
      await owned.database
        .client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
        VALUES (${conversationID}, ${owned.projectID}, ${owned.ticketID}, 'build', ${owned.userID})`;
      const commandID = crypto.randomUUID();
      await controller.prompt(owned.changeID, "Owned commit authority", owned.userID, commandID);
      await owned.requested;
      owned.finish();
      owned.release();
      await prepareEntered.promise;
      if (boundary === "Stop")
        await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
      if (boundary === "Requirements") {
        const content = canonicalRequirementContent({
          summary: "Changed approval boundary",
          acceptanceCriteria: ["Needs a new exact approval"],
          nonGoals: [],
        });
        await owned.database.client.begin(async (sql) => {
          await sql`SELECT id FROM factory.ticket WHERE id = ${owned.ticketID} FOR UPDATE`;
          await sql`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
            VALUES (${crypto.randomUUID()}, ${owned.ticketID}, 2, ${content},
              ${createHash("sha256").update(content).digest("hex")}, ${owned.userID})`;
        });
      }
      if (boundary === "mode") {
        await owned.database
          .client`UPDATE factory.ticket_conversation SET mode = 'plan', version = version + 1
          WHERE id = ${conversationID}`;
        await owned.database
          .client`UPDATE factory.ticket_conversation SET mode = 'build', version = version + 1
          WHERE id = ${conversationID}`;
      }
      if (boundary === "generation")
        await owned.database
          .client`UPDATE factory.change SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
      if (boundary === "Change")
        await owned.database
          .client`UPDATE factory.change SET state = 'cancelled', cancelled_at = now()
          WHERE id = ${owned.changeID}`;
      releasePrepare.resolve();
      await until(async () => {
        const rows = await owned.database.client<Array<{ state: string }>>`
          SELECT state FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
        return rows[0]?.state === "failed" || rows[0]?.state === "succeeded";
      });
      expect(owned.commitCalls).toEqual(["git-prepare-commit"]);
      const view = await controller.get(owned.changeID);
      expect(view.state).toBe(
        boundary === "Stop" ? "stopped" : boundary === "generation" ? "waiting" : "failed",
      );
      expect(view.turn?.state).toBe("completed");
      const records = await owned.database.client<
        Array<{ state: string; commitSHA: string | null }>
      >`
        SELECT state, commit_sha AS "commitSHA" FROM factory.change_commit_operation
        WHERE change_id = ${owned.changeID}`;
      expect([...records]).toEqual([{ state: "failed", commitSHA: "d".repeat(40) }]);
      expect(owned.requests()).toBe(1);
    } finally {
      releasePrepare.resolve();
      await controller.shutdown();
      owned.hub.parentOperation = operation;
      await owned.dispose();
    }
  },
);

test.each(["parallel", "late follower"] as const)(
  "two Controllers preserve one commit owner with %s recovery",
  async (timing) => {
    const owned = await fixture();
    const frames: Array<{ operationId: string; action: string }> = [];
    const entered = Promise.withResolvers<void>();
    const follower = Promise.withResolvers<void>();
    let callers = 0;
    let followerHeld = false;
    const original = RuntimeHub.prototype.parentOperation.bind(owned.hub);
    owned.hub.parentOperation = async (...args) => {
      callers += 1;
      const caller = callers;
      if (callers === 2) entered.resolve();
      const result = await original(...args);
      if (caller === 2 && timing === "late follower") {
        followerHeld = true;
        await follower.promise;
      }
      return result;
    };
    const parent = {
      data: { kind: "connector", role: "parent", attemptID: owned.attemptID, generation: 1 },
      close() {},
      send(raw: string) {
        const frame = JSON.parse(raw) as (typeof frames)[number];
        frames.push(frame);
        if (frame.action === "git-push") queueMicrotask(() => respond(frame.operationId));
        return 1;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    function respond(operationId: string) {
      const action = frames.at(-1)?.action;
      owned.hub.message(
        parent,
        JSON.stringify({
          type: "operation-response",
          operationId,
          action,
          commitSha: "d".repeat(40),
          remoteSha: "d".repeat(40),
        }),
      );
    }
    owned.hub.open(parent);
    const first = owned.controller();
    const recovery = owned.controller();
    const second = owned.controller();
    try {
      await first.prompt(
        owned.changeID,
        "Owned concurrent commit",
        owned.userID,
        crypto.randomUUID(),
      );
      await owned.requested;
      owned.finish();
      owned.release();
      await until(async () => frames.length === 1);
      // Lose the original prepare response before two Controllers observe the
      // same operation. Hold their shared response to exercise late publication.
      owned.hub.suspend(owned.attemptID);
      await first.shutdown();
      frames.length = 0;
      callers = 0;
      await recovery.recover();
      await second.recover();
      await entered.promise;
      // The failing duplicate caller settles immediately; a coalesced caller stays pending.
      const secondClosed = second.shutdown();
      expect(
        await Promise.race([
          secondClosed.then(() => "settled"),
          Bun.sleep(100).then(() => "pending"),
        ]),
      ).toBe("pending");
      const prepare = frames[0];
      if (!prepare) throw new Error("Owned held prepare required");
      respond(prepare.operationId);
      await recovery.shutdown();
      expect(followerHeld).toBe(timing === "late follower");
      follower.resolve();
      await secondClosed;
      const rows = await owned.database.client<Array<{ state: string }>>`
      SELECT state FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
      expect(rows[0]?.state).toBe("succeeded");
      expect(frames.map(({ action }) => action)).toEqual(["git-observe-commit", "git-push"]);
      expect((await first.get(owned.changeID)).state).toBe("committed");
      expect(owned.requests()).toBe(1);
    } finally {
      follower.resolve();
      owned.hub.revoke(owned.attemptID);
      await first.shutdown();
      await recovery.shutdown();
      await second.shutdown();
      await owned.dispose();
    }
  },
);

test.each(["Stop", "generation", "Session", "mode"] as const)(
  "a late push acknowledgement records its outcome without publishing after changed %s",
  async (boundary) => {
    const owned = await fixture();
    const controller = owned.controller();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = owned.hub.parentOperation.bind(owned.hub);
    owned.hub.parentOperation = async (...args) => {
      const result = await original(...args);
      if (args[1]["action"] === "git-push") {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    try {
      const conversationID = crypto.randomUUID();
      await owned.database
        .client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
        VALUES (${conversationID}, ${owned.projectID}, ${owned.ticketID}, 'build', ${owned.userID})`;
      await controller.prompt(owned.changeID, "Owned held push", owned.userID, crypto.randomUUID());
      await owned.requested;
      owned.finish();
      owned.release();
      await entered.promise;
      if (boundary === "Stop")
        await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
      if (boundary === "generation")
        await owned.database.client`UPDATE factory.change
        SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
      if (boundary === "Session")
        await owned.database.client`UPDATE factory.change_agent_session
        SET opencode_session_id = 'ses_replacement' WHERE change_id = ${owned.changeID}`;
      if (boundary === "mode")
        await owned.database.client`UPDATE factory.ticket_conversation
        SET mode = 'plan', version = version + 1 WHERE id = ${conversationID}`;
      release.resolve();
      await controller.shutdown();
      const rows = await owned.database.client<Array<{ state: string; remote: string }>>`
        SELECT state, observed_remote_sha AS remote FROM factory.change_commit_operation
          WHERE change_id = ${owned.changeID}`;
      expect([...rows]).toEqual([{ state: "succeeded", remote: "d".repeat(40) }]);
      const sessions = await owned.database.client<Array<{ state: string }>>`
        SELECT state FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
      expect(sessions[0]?.state).toBe(boundary === "Stop" ? "stopped" : "waiting");
      expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
      expect(owned.requests()).toBe(1);
    } finally {
      release.resolve();
      await controller.shutdown();
      await owned.dispose();
    }
  },
);
