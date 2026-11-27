import { expect, test } from "bun:test";
import { personalWorkspaceIdentity } from "#workspace-domain/workspace";
import { type RuntimeHub, RuntimeParentOperationError } from "../../apps/factory/src/runtime/hub";
import {
  createPersonalGit,
  personalGitRepository,
} from "../../apps/factory/src/workspace/personal-git";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";
import { fixtureValue } from "../fixtures/value";

test("personal Git retains intent before dispatch, rechecks authority and never replays uncertain writes", async () => {
  const previousInternalURL = process.env["FACTORY_INTERNAL_URL"];
  process.env["FACTORY_INTERNAL_URL"] = "http://factory-internal.release.svc:3000";
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const workspaceID = personalWorkspaceIdentity(owned.projectID, owned.userID).workspaceID;
    const head = "a".repeat(40);
    const next = "b".repeat(40);
    await database.client`
      INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,
        source_revision,created_by)
      VALUES(${workspaceID},${owned.projectID},'personal',${owned.userID},'main',${head},${owned.userID})`;
    const attemptID = await recordUncreatedWorkspaceAttempt(database, {
      workspaceID,
      generation: 1,
      createdBy: owned.userID,
      parentHash: "c".repeat(64),
      childHash: "d".repeat(64),
      connectorURL: "wss://owned-build.factory.invalid/internal/runtime-connect",
    });
    let currentAttemptID = attemptID;
    let mode: "success" | "lost" | "rejected" | "stopped" | "revoked" = "success";
    let sends = 0;
    let remoteHead = head;
    const hub: Pick<RuntimeHub, "connected" | "parentOperation"> = {
      connected: (id) => id === currentAttemptID,
      async parentOperation(id, operation, beforeSend) {
        expect(id).toBe(currentAttemptID);
        const input = JSON.parse(String(operation["data"])) as {
          action: string;
          repository?: string;
        };
        if (mode === "revoked")
          await database.client`UPDATE factory.project_membership SET role='product-contributor'
            WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
        if (mode === "stopped")
          await database.client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
            WHERE id=${attemptID}`;
        await beforeSend?.(() => {
          sends++;
        });
        if (input.action !== "status" && input.action !== "diff") {
          const [intent] = await database.client<
            Array<{ state: string }>
          >`SELECT state FROM factory.operation WHERE id=${operation.operationId} AND kind='workspace.personal_git'`;
          expect(intent?.state).toBe("attempted");
          if (input.action === "fetch" || input.action === "pull") {
            const callback = new URL(input.repository ?? "");
            expect(callback.origin).toBe("https://owned-build.factory.invalid");
            expect(callback.pathname).toStartWith(
              `/internal/personal-git/${operation.operationId}/`,
            );
            expect(await personalGitRepository(database, operation.operationId)).toBe(
              "https://owned-build.factory.invalid/owned/owned-build.git",
            );
          }
        }
        if (mode === "lost") throw new Error("Owned response lost");
        if (mode === "rejected")
          throw new RuntimeParentOperationError("workspace-git", "Commit changes before pulling");
        if (input.action === "commit") remoteHead = next;
        return { data: JSON.stringify({ head: remoteHead, branch: "main", files: [] }) };
      },
    };
    const git = createPersonalGit(database, hub);
    await expect(git.read(workspaceID, crypto.randomUUID())).rejects.toThrow(
      "Account access is disabled",
    );
    await expect(
      git.read(
        fixtureValue(
          (
            await database.client<
              Array<{ id: string }>
            >`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`
          )[0],
          "( await database.client< Array<{ id: string }> >`SELECT id FROM factory.development_workspace WHERE change_id=${owned.ch",
        ).id,
        owned.userID,
      ),
    ).rejects.toThrow("personal Workspace");
    expect(sends).toBe(0);
    expect(await git.read(workspaceID, owned.userID)).toEqual({ head, branch: "main", files: [] });
    expect(
      await database.client`SELECT id FROM factory.operation WHERE kind='workspace.personal_git' AND scope_type='workspace' AND scope_id=${workspaceID}`,
    ).toHaveLength(0);
    const peer = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email)VALUES(${peer},'Git collaborator',${`${peer}@factory.invalid`})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)VALUES(${owned.projectID},${peer},'developer',${owned.userID})`;
    await expect(git.read(workspaceID, peer)).rejects.toThrow("Workspace not found");
    await createWorkspaceSharing(database, () => {}).decide(owned.userID, {
      commandID: crypto.randomUUID(),
      workspaceID,
      userID: peer,
      permission: "collaborate",
      expectedVersion: 0,
    });
    expect(await git.read(workspaceID, peer)).toEqual({ head, branch: "main", files: [] });
    expect(
      (
        await git.mutate(workspaceID, peer, "fetch", {
          commandID: crypto.randomUUID(),
          expectedHead: head,
        })
      ).head,
    ).toBe(head);
    const command = {
      commandID: crypto.randomUUID(),
      expectedHead: head,
      message: "Personal work",
    };
    const beforeCommit = sends;
    const [result, replay] = await Promise.all([
      git.mutate(workspaceID, owned.userID, "commit", command),
      git.mutate(workspaceID, owned.userID, "commit", command),
    ]);
    expect(replay).toEqual(result);
    expect(sends).toBe(beforeCommit + 1);
    expect(result.head).toBe(next);
    const [source] = await database.client<{ revision: string; generation: string }[]>`
      SELECT workspace.source_revision AS revision,attempt.generation
      FROM factory.development_workspace workspace JOIN factory.runtime_attempt attempt
        ON attempt.workspace_id=workspace.id WHERE attempt.id=${attemptID}`;
    expect(source).toEqual({ revision: head, generation: "1" });
    const sent = sends;
    expect(await git.mutate(workspaceID, owned.userID, "commit", command)).toEqual(result);
    expect(sends).toBe(sent);
    await expect(
      git.mutate(workspaceID, owned.userID, "commit", { ...command, message: "Another intent" }),
    ).rejects.toThrow("another request");
    mode = "lost";
    const lost = { commandID: crypto.randomUUID(), expectedHead: next };
    await expect(git.mutate(workspaceID, owned.userID, "fetch", lost)).rejects.toThrow(
      "unconfirmed",
    );
    expect(await personalGitRepository(database, lost.commandID)).toBeNull();
    const sentLost = sends;
    await expect(git.mutate(workspaceID, owned.userID, "fetch", lost)).rejects.toThrow(
      "unconfirmed",
    );
    expect(sends).toBe(sentLost);
    mode = "rejected";
    const rejectedID = crypto.randomUUID();
    await expect(
      git.mutate(workspaceID, owned.userID, "pull", {
        commandID: rejectedID,
        expectedHead: next,
      }),
    ).rejects.toThrow("Commit changes");
    const [rejected] = await database.client<Array<{ state: string }>>`
      SELECT state FROM factory.operation WHERE id=${rejectedID} AND kind='workspace.personal_git'`;
    expect(rejected?.state).toBe("failed");
    mode = "stopped";
    const stopCommandID = crypto.randomUUID();
    const beforeStop = sends;
    await expect(
      git.mutate(workspaceID, owned.userID, "fetch", {
        commandID: stopCommandID,
        expectedHead: next,
      }),
    ).rejects.toThrow("Personal Workspace execution changed");
    expect(sends).toBe(beforeStop);
    expect(await personalGitRepository(database, stopCommandID)).toBeNull();
    const [stopped] = await database.client<{ state: string; attempt: string }[]>`
      SELECT state,payload->>'runtimeAttemptId' AS attempt FROM factory.operation
      WHERE id=${stopCommandID} AND kind='workspace.personal_git'`;
    expect(stopped).toEqual({ state: "failed", attempt: attemptID });
    // Continue the authority regression on a separate fresh fixture generation.
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${attemptID}`;
    currentAttemptID = await recordUncreatedWorkspaceAttempt(database, {
      workspaceID,
      generation: 2,
      createdBy: owned.userID,
      parentHash: "e".repeat(64),
      childHash: "f".repeat(64),
      connectorURL: "wss://owned-build.factory.invalid/internal/runtime-connect",
    });
    mode = "success";
    await expect(git.mutate(workspaceID, owned.userID, "fetch", lost)).rejects.toThrow(
      "unconfirmed",
    );
    expect(sends).toBe(beforeStop);
    const [retained] = await database.client<{ attempt: string }[]>`
      SELECT payload->>'runtimeAttemptId' AS attempt FROM factory.operation
      WHERE id=${lost.commandID} AND kind='workspace.personal_git'`;
    expect(retained?.attempt).toBe(attemptID);
    mode = "revoked";
    const beforeRevoked = sends;
    await expect(
      git.mutate(workspaceID, owned.userID, "fetch", {
        commandID: crypto.randomUUID(),
        expectedHead: next,
      }),
    ).rejects.toThrow("Developer access required");
    expect(sends).toBe(beforeRevoked);
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
    if (previousInternalURL === undefined) delete process.env["FACTORY_INTERNAL_URL"];
    else process.env["FACTORY_INTERNAL_URL"] = previousInternalURL;
  }
}, 30_000);
