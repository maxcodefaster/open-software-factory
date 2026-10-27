import { expect, test } from "bun:test";
import { type RuntimeHub, RuntimeParentOperationError } from "../../apps/factory/src/runtime/hub";
import {
  createPersonalGit,
  personalGitRepository,
} from "../../apps/factory/src/workspace/personal-git";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("personal Git retains intent before dispatch, rechecks authority and never replays uncertain writes", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const workspaceID = crypto.randomUUID();
    const attemptID = crypto.randomUUID();
    const head = "a".repeat(40);
    const next = "b".repeat(40);
    await database.client`
      INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,
        source_revision,created_by)
      VALUES(${workspaceID},${owned.projectID},'personal',${owned.userID},'main',${head},${owned.userID})`;
    await database.client`
      INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,
        create_intended_at,created_by)
      VALUES(${attemptID},${owned.projectID},${workspaceID},1,${head},'ready',${"c".repeat(64)},${"d".repeat(64)},now(),${owned.userID})`;
    let mode: "success" | "lost" | "rejected" | "revoked" = "success";
    let sends = 0;
    let remoteHead = head;
    const hub: Pick<RuntimeHub, "connected" | "parentOperation"> = {
      connected: (id) => id === attemptID,
      async parentOperation(id, operation, beforeSend) {
        expect(id).toBe(attemptID);
        const input = JSON.parse(String(operation["data"])) as { action: string };
        if (mode === "revoked")
          await database.client`UPDATE factory.project_membership SET role='product-contributor'
            WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
        await beforeSend?.(() => {
          sends++;
        });
        if (input.action !== "status" && input.action !== "diff") {
          const [intent] = await database.client<
            Array<{ state: string }>
          >`SELECT state FROM factory.personal_git_operation WHERE id=${operation.operationId}`;
          expect(intent?.state).toBe("attempted");
          if (input.action === "fetch" || input.action === "pull")
            expect(await personalGitRepository(database, operation.operationId)).toBe(
              "https://example.invalid/owned-build.git",
            );
        }
        if (mode === "lost") throw new Error("Owned response lost");
        if (mode === "rejected")
          throw new RuntimeParentOperationError("workspace-git", "Commit changes before pulling");
        if (input.action === "commit") remoteHead = next;
        return { data: JSON.stringify({ head: remoteHead, branch: "main", files: [] }) };
      },
    };
    const git = createPersonalGit(database, hub);
    await expect(git.read(workspaceID, crypto.randomUUID())).rejects.toThrow("personal Workspace");
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
      await database.client`SELECT id FROM factory.personal_git_operation WHERE workspace_id=${workspaceID}`,
    ).toHaveLength(0);
    const command = {
      commandID: crypto.randomUUID(),
      expectedHead: head,
      message: "Personal work",
    };
    const result = await git.mutate(workspaceID, owned.userID, "commit", command);
    expect(result.head).toBe(next);
    const sent = sends;
    expect(await git.mutate(workspaceID, owned.userID, "commit", command)).toEqual(result);
    expect(sends).toBe(sent);
    await expect(
      git.mutate(workspaceID, owned.userID, "commit", { ...command, message: "Another intent" }),
    ).rejects.toThrow("another request");
    await expect(
      (async () => {
        await database.client`UPDATE factory.personal_git_operation SET message='changed'
          WHERE id=${command.commandID}`;
      })(),
    ).rejects.toThrow("immutable");
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
      SELECT state FROM factory.personal_git_operation WHERE id=${rejectedID}`;
    expect(rejected?.state).toBe("failed");
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
  }
}, 30_000);
