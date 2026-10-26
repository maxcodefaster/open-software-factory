import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createAgentCommitTransport } from "../../apps/factory/src/agent/commit-transport";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";

test.each(["same Workspace", "Stop"])(
  "replacement checkout observation is read-only and scoped: %s",
  async (boundary) => {
    const owned = await fixture();
    const controller = owned.controller();
    const replacementID = crypto.randomUUID();
    const actions: string[] = [];
    try {
      const accepted = await controller.prompt(
        owned.changeID,
        "Owned absent commit",
        owned.userID,
        crypto.randomUUID(),
      );
      await owned.requested;
      owned.finish();
      owned.release();
      await eventually(
        async () => (await controller.get(owned.changeID)).state,
        (state) => state === "committed",
        "Original commit did not settle",
      );
      await controller.shutdown();
      const turnID = accepted.turn?.id;
      if (!turnID) throw new Error("Retained commit turn missing");
      const [original] = await owned.database.client<Array<{ workspace: string; sha: string }>>`
        SELECT workspace_id AS workspace, revision AS sha FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
      if (!original) throw new Error("Original Workspace missing");
      await owned.database
        .client`UPDATE factory.change_commit_operation SET state = 'commit-intended', commit_sha = NULL,
      observed_remote_sha = NULL, completed_at = NULL WHERE id = ${turnID}`;
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state = 'failed' WHERE id = ${owned.attemptID}`;
      await owned.database
        .client`INSERT INTO factory.runtime_attempt(id, project_id, change_id, workspace_id, generation, revision, state, parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
      SELECT ${replacementID}, project_id, change_id, ${original.workspace}::uuid,
        2, revision, 'ready', parent_connector_token_hash, child_connector_token_hash, now(), created_by
      FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
      await owned.database
        .client`UPDATE factory.change SET runtime_attempt_id = ${replacementID} WHERE id = ${owned.changeID}`;
      await owned.database
        .client`UPDATE factory.change_agent_session SET state = ${boundary === "Stop" ? "stopped" : "waiting"}::factory.change_agent_state, stop_pending = ${boundary === "Stop"},
        stop_id = ${boundary === "Stop" ? crypto.randomUUID() : null}::uuid
      WHERE change_id = ${owned.changeID}`;
      const hub = new RuntimeHub(async () => {});
      const parent = {
        data: { kind: "connector", role: "parent", attemptID: replacementID, generation: 2 },
        close() {},
        send(raw: string) {
          const frame = JSON.parse(raw) as { operationId: string; action: string };
          actions.push(frame.action);
          queueMicrotask(() =>
            hub.message(
              parent,
              JSON.stringify({
                type: "operation-response",
                operationId: frame.operationId,
                action: frame.action,
                error: "the exact prepared commit was not found; current files were not committed",
              }),
            ),
          );
          return 1;
        },
      } as unknown as ServerWebSocket<RuntimeSocketData>;
      hub.open(parent);
      try {
        const transport = createAgentCommitTransport(owned.database, hub);
        await expect(
          transport.observeRetainedCheckout(owned.attemptID, {
            operationId: turnID,
            action: "git-observe-commit",
            expectedSha: original.sha,
            commitMessage: "Owned Build regression",
            authorName: "Factory",
            authorEmail: "factory@localhost",
          }),
        ).rejects.toThrow();
        expect(actions).toEqual(boundary === "same Workspace" ? ["git-observe-commit"] : []);
        const [intent] = await owned.database.client<
          Array<{ runtime: string }>
        >`SELECT runtime_attempt_id AS runtime FROM factory.change_commit_operation WHERE id = ${turnID}`;
        expect(intent?.runtime).toBe(owned.attemptID);
      } finally {
        hub.revoke(replacementID);
      }
    } finally {
      await controller.shutdown();
      await owned.database
        .client`UPDATE factory.change SET runtime_attempt_id = ${owned.attemptID} WHERE id = ${owned.changeID}`;
      await owned.database
        .client`DELETE FROM factory.runtime_attempt WHERE id = ${replacementID} AND project_id = ${owned.projectID} AND kubernetes_uid IS NULL AND kubernetes_namespace_uid IS NULL`;
      await owned.dispose();
    }
  },
);

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "empty implementation never restores earlier completion, recovery=%s previousCommit=%s",
  async (recovering, previousCommit) => {
    const owned = await fixture();
    const controller = owned.controller();
    const recovery = owned.controller();
    const actions: string[] = [];
    owned.hub.parentOperation = RuntimeHub.prototype.parentOperation.bind(owned.hub);
    const parent = {
      data: { kind: "connector", role: "parent", attemptID: owned.attemptID, generation: 1 },
      close() {},
      send(raw: string) {
        const frame = JSON.parse(raw) as { operationId: string; action: string };
        actions.push(frame.action);
        queueMicrotask(() =>
          owned.hub.message(
            parent,
            JSON.stringify({
              type: "operation-response",
              operationId: frame.operationId,
              action: frame.action,
              error:
                frame.action === "git-observe-commit"
                  ? "the exact prepared commit was not found; current files were not committed"
                  : "workspace has no changes to commit",
            }),
          ),
        );
        return 1;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    owned.hub.open(parent);
    try {
      if (previousCommit) {
        await owned.database.client`
          INSERT INTO factory.change_commit_operation(
            id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
            commit_sha, observed_remote_sha, commit_message, idempotency_key, state,
            created_by, completed_at
          )
          SELECT ${crypto.randomUUID()}, id, runtime_attempt_id, 1, branch_name, base_sha,
            ${"e".repeat(40)}, ${"e".repeat(40)}, 'Earlier implementation',
            ${crypto.randomUUID()}, 'succeeded', created_by, now()
          FROM factory.change WHERE id = ${owned.changeID}`;
      }
      const accepted = await controller.prompt(
        owned.changeID,
        "Inspect without changes",
        owned.userID,
        crypto.randomUUID(),
      );
      await owned.requested;
      owned.finish();
      owned.release();
      await eventually(
        async () => {
          const [row] = await owned.database.client<
            Array<{ state: string }>
          >`SELECT state FROM factory.change_commit_operation WHERE id = ${accepted.turn?.id ?? ""}`;
          return row;
        },
        (value) => !!value,
        "Empty turn commit intent absent",
      );
      await controller.shutdown();
      if (recovering) {
        await owned.database
          .client`UPDATE factory.change_commit_operation SET state = 'commit-intended', completed_at = NULL,
        last_error = 'Commit outcome not confirmed. New Build waits for recovery. workspace has no changes to commit'
        WHERE id = ${accepted.turn?.id ?? ""}`;
        await owned.database
          .client`UPDATE factory.change_agent_session SET state = 'waiting' WHERE change_id = ${owned.changeID}`;
        await recovery.recover();
        await recovery.shutdown();
      }
      const view = await recovery.get(owned.changeID);
      expect(view.commitOperation).toBeUndefined();
      expect(view.state).toBe(recovering ? "failed" : "waiting");
      if (recovering) expect(view.lastError).toContain("Files were left untouched");
      else expect(view.lastError).toContain("No new commit was submitted");
      expect(view.turn?.state).toBe("completed");
      const [operation] = await owned.database.client<Array<{ state: string; sha: string | null }>>`
      SELECT state, commit_sha AS sha FROM factory.change_commit_operation WHERE id = ${accepted.turn?.id ?? ""}`;
      expect(operation).toEqual({ state: "failed", sha: null });
      expect(actions).not.toContain("git-push");
      expect(owned.requests()).toBe(1);
    } finally {
      owned.hub.revoke(owned.attemptID);
      await Promise.all([controller.shutdown(), recovery.shutdown()]);
      await owned.dispose();
    }
  },
);

const actions = ["git-prepare-commit", "git-push"] as const;
const boundaries = ["restore", "Stop", "mode", "runtime", "Session"] as const;
const cases = actions.flatMap((action) => [
  ...boundaries.map((boundary) => [action, boundary, "disconnect"] as const),
  ...boundaries.map((boundary) => [action, boundary, "crash before outcome persistence"] as const),
  [action, "restore", "reported error"] as const,
  [action, "restore", "missing identity"] as const,
]);
test.each(cases)(
  "%s under %s recovery retains intent after %s",
  async (lostAction, boundary, fault) => {
    const owned = await fixture();
    const entered = Promise.withResolvers<void>();
    const frames: Array<{ operationId: string; action: string }> = [];
    let losing = true;
    owned.hub.parentOperation = RuntimeHub.prototype.parentOperation.bind(owned.hub);
    const parent = {
      data: { kind: "connector", role: "parent", attemptID: owned.attemptID, generation: 1 },
      close() {},
      send(raw: string) {
        const frame = JSON.parse(raw) as (typeof frames)[number];
        frames.push(frame);
        const unresolved = losing && frame.action === lostAction;
        if (unresolved) entered.resolve();
        if (!unresolved || !["disconnect", "crash before outcome persistence"].includes(fault))
          queueMicrotask(() =>
            owned.hub.message(
              parent,
              JSON.stringify({
                type: "operation-response",
                operationId: frame.operationId,
                action: frame.action,
                ...(unresolved
                  ? fault === "reported error"
                    ? { error: "Git observation failed after mutation" }
                    : {}
                  : {
                      commitSha: "d".repeat(40),
                      remoteSha: "d".repeat(40),
                    }),
              }),
            ),
          );
        return 1;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    owned.hub.open(parent);
    const controller = owned.controller();
    const recovery = owned.controller();
    const follower = owned.controller();
    const conversationID = crypto.randomUUID();
    try {
      await owned.database
        .client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
        VALUES (${conversationID}, ${owned.projectID}, ${owned.ticketID}, 'build', ${owned.userID})`;
      await controller.prompt(
        owned.changeID,
        "Owned lost commit response",
        owned.userID,
        crypto.randomUUID(),
      );
      await owned.requested;
      owned.finish();
      owned.release();
      await entered.promise;
      if (["disconnect", "crash before outcome persistence"].includes(fault))
        owned.hub.suspend(owned.attemptID);
      await controller.shutdown();
      const rows = await owned.database.client<
        Array<{ id: string; state: string; error: string | null }>
      >`
        SELECT id, state, last_error AS error FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
      const record = rows[0];
      if (!record) throw new Error("Owned commit intent is missing");
      expect(record.state).toBe(lostAction === "git-push" ? "push-intended" : "commit-intended");
      expect(record.error).toContain("not confirmed");
      const view = await recovery.get(owned.changeID);
      expect(view.commitOperation?.id).toBe(record.id);
      expect(view.commitOperation?.lastError).toContain("not confirmed");
      await expect(
        recovery.prompt(
          owned.changeID,
          "Do not overlap unresolved commit",
          owned.userID,
          crypto.randomUUID(),
        ),
      ).rejects.toThrow("current commit operation");
      if (fault === "crash before outcome persistence")
        await owned.database.client`UPDATE factory.change_commit_operation SET last_error = NULL
          WHERE id = ${record.id}`;
      if (boundary === "Stop")
        await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
      if (boundary === "mode")
        await owned.database
          .client`UPDATE factory.ticket_conversation SET mode = 'plan', version = version + 1
          WHERE id = ${conversationID}`;
      if (boundary === "runtime")
        await owned.database
          .client`UPDATE factory.change SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
      if (boundary === "Session")
        await owned.database
          .client`UPDATE factory.change_agent_session SET opencode_session_id = 'ses_owned_replacement',
          last_error = 'Retain replacement Session' WHERE change_id = ${owned.changeID}`;
      const before = frames.length;
      losing = false;
      await Promise.all([recovery.recover(), follower.recover()]);
      await Promise.all([recovery.shutdown(), follower.shutdown()]);
      const settled = await owned.database.client<
        Array<{ id: string; state: string; error: string | null }>
      >`
        SELECT id, state, last_error AS error FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
      expect(settled[0]?.id).toBe(record.id);
      expect(settled[0]?.state).toBe(boundary === "restore" ? "succeeded" : record.state);
      if (boundary === "restore") {
        expect(settled[0]?.error).toBeNull();
        expect((await recovery.get(owned.changeID)).state).toBe("committed");
        expect((await recovery.get(owned.changeID)).commitOperation).toBeUndefined();
        expect(frames.slice(before).every(({ action }) => action !== "git-prepare-commit")).toBe(
          true,
        );
      } else {
        expect(settled[0]?.error).toContain("not confirmed");
        expect(frames).toHaveLength(before);
        if (boundary === "Session")
          expect((await recovery.get(owned.changeID)).lastError).toBe("Retain replacement Session");
      }
      expect(frames.every(({ operationId }) => operationId === record.id)).toBe(true);
      expect(owned.requests()).toBe(1);
    } finally {
      owned.hub.revoke(owned.attemptID);
      await Promise.all([controller.shutdown(), recovery.shutdown(), follower.shutdown()]);
      await owned.dispose();
    }
  },
);
