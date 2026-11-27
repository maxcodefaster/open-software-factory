import { expect, test } from "bun:test";
import { workspaceWriteAuthorityIn } from "../../apps/factory/src/access/change-writer";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { workspaceAuthorityIn } from "../../apps/factory/src/access/workspace";
import { createWorkspaceService } from "../../apps/factory/src/workspace/service";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

async function fixture() {
  const native = await substrateFixture();
  const { database, userID: owner, projectID: project, workspaceID: workspace } = native;
  const editor = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  for (const id of [editor, viewer, contributor])
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Sharing fixture',${`${id}@factory.invalid`})`;
  for (const id of [editor, viewer, contributor])
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${project},${id},${id === contributor ? "product-contributor" : "developer"},${owner})`;
  const revoked: { workspaceID: string; userID: string }[] = [];
  const sharing = createWorkspaceSharing(database, (workspaceID, userID) => {
    revoked.push({ workspaceID, userID });
  });
  const read = (userID: string) =>
    database.client.begin((sql) => workspaceAuthorityIn(sql, workspace, userID));
  const write = (userID: string) =>
    database.client.begin((sql) => workspaceWriteAuthorityIn(sql, workspace, userID));
  const grant = (
    userID: string,
    permission: "observe" | "collaborate" | null,
    expectedVersion = 0,
    commandID = crypto.randomUUID(),
  ) =>
    sharing.decide(owner, {
      commandID,
      workspaceID: workspace,
      userID,
      permission,
      expectedVersion,
    });
  const noPreparation = async () => {
    throw Error("Listing Workspaces must not prepare Source or compute");
  };
  const service = createWorkspaceService({
    database,
    sources: {
      get: noPreparation,
      ensure: noPreparation,
      ensurePersonal: noPreparation,
      ensureChange: noPreparation,
    },
    editors: { get: noPreparation, ensure: noPreparation, stop: noPreparation },
    revokeEditor: noPreparation,
  });
  return {
    native,
    database,
    owner,
    editor,
    viewer,
    contributor,
    project,
    workspace,
    sharing,
    revoked,
    read,
    write,
    grant,
    available: (userID: string) => service.available(userID, project),
    async dispose() {
      await native.dispose();
    },
  };
}

test("personal source is private until shared and grants never elevate Project authority", async () => {
  const f = await fixture();
  try {
    expect((await f.read(f.owner)).permission).toBe("collaborate");
    expect(await f.available(f.owner)).toEqual([
      {
        workspaceID: f.workspace,
        ownerID: f.owner,
        name: "Native fixture",
        kind: "personal",
        collaborative: false,
      },
    ]);
    expect(await f.available(f.editor)).toEqual([]);
    await expect(f.read(f.editor)).rejects.toThrow("Workspace not found");
    await expect(f.grant(f.contributor, "collaborate")).rejects.toThrow(
      "Developer access required",
    );
    expect(
      (await f.sharing.view(f.owner, f.workspace)).members.map((m) => m.userID).sort(),
    ).toEqual([f.editor, f.viewer].sort());
    await f.grant(f.viewer, "observe");
    expect((await f.available(f.viewer)).map((row) => row.workspaceID)).toEqual([f.workspace]);
    expect((await f.read(f.viewer)).permission).toBe("observe");
    await expect(f.write(f.viewer)).rejects.toThrow("observation only");
    await f.grant(f.editor, "collaborate");
    expect((await f.write(f.editor)).ownerID).toBe(f.owner);
    await expect(f.sharing.view(f.editor, f.workspace)).rejects.toThrow("Only the Workspace owner");
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.project} AND user_id=${f.editor}`;
    await expect(f.write(f.editor)).rejects.toThrow("Developer access required");
    await expect(f.available(f.editor)).rejects.toThrow("Developer access required");
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 30000);

test("sharing retries observe the original decision, not newer permissions", async () => {
  const f = await fixture();
  try {
    const commandID = crypto.randomUUID();
    const first = await f.grant(f.editor, "collaborate", 0, commandID);
    const second = await f.grant(f.editor, "observe", 1);
    expect(second.version).toBe(2);
    expect(await f.grant(f.editor, "collaborate", 0, commandID)).toEqual(first);
    expect((await f.read(f.editor)).permission).toBe("observe");
    await expect(f.grant(f.editor, "observe", 0, commandID)).rejects.toThrow("different decision");
    await expect(f.grant(f.editor, "collaborate", 1)).rejects.toThrow("sharing changed");
    const [count] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.operation WHERE kind='workspace.share_decision'`;
    expect(count?.count).toBe(2);
  } finally {
    await f.dispose();
  }
}, 30000);

test("a kick revokes only the member's access and preserves shared runtime identity and state", async () => {
  const f = await fixture();
  const attemptID = f.native.attemptID;
  try {
    await f.grant(f.editor, "collaborate");
    await f.grant(f.viewer, "observe");
    await startSubstrateFixtureWorkspace(f.native);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${attemptID}`;
    const access = createAccessController(f.database);
    await access.requireRuntime(f.editor, attemptID, "ide");
    const [before] = await f.database
      .client`SELECT * FROM factory.runtime_attempt WHERE id=${attemptID}`;
    const result = await f.grant(f.editor, null, 1);
    expect(result.permission).toBeNull();
    expect(await f.available(f.editor)).toEqual([]);
    expect(f.revoked.at(-1)).toEqual({ workspaceID: f.workspace, userID: f.editor });
    await expect(f.read(f.editor)).rejects.toThrow("Workspace not found");
    await expect(access.requireRuntime(f.editor, attemptID, "app")).rejects.toThrow(
      "Workspace not found",
    );
    await access.requireRuntime(f.viewer, attemptID, "app");
    expect((await f.read(f.owner)).ownerID).toBe(f.owner);
    const [after] = await f.database
      .client`SELECT * FROM factory.runtime_attempt WHERE id=${attemptID}`;
    expect(after).toEqual(before);
  } finally {
    await f.dispose();
  }
}, 30000);

test("pending access revocation is recovered without undoing a later sharing decision", async () => {
  const f = await fixture();
  try {
    await f.grant(f.editor, "collaborate");
    const commandID = crypto.randomUUID();
    let loseReply = true;
    let calls = 0;
    const sharing = createWorkspaceSharing(f.database, () => {
      calls++;
      if (loseReply) throw new Error("lost access revocation acknowledgement");
    });
    await expect(
      sharing.decide(f.owner, {
        commandID,
        workspaceID: f.workspace,
        userID: f.editor,
        permission: null,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("lost access revocation");
    await expect(f.read(f.editor)).rejects.toThrow("Workspace not found");
    await f.grant(f.editor, "collaborate", 2);
    loseReply = false;
    await sharing.recover();
    expect(calls).toBe(1);
    expect((await f.read(f.editor)).permission).toBe("collaborate");
    const [pending] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.operation WHERE kind='workspace.share_decision' AND completed_at IS NULL`;
    expect(pending?.count).toBe(0);
  } finally {
    await f.dispose();
  }
}, 30000);

test("an invited collaborator connects to the owner's native compute, not a second personal Workspace", async () => {
  const f = await fixture();
  const attemptID = f.native.attemptID;
  try {
    await f.grant(f.editor, "collaborate");
    await f.grant(f.viewer, "observe");
    const controller = await startSubstrateFixtureWorkspace(f.native);
    await f.database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now()
      WHERE id=${attemptID}`;
    const [original] = await f.database.client`
      SELECT parent_connector_token_hash
      FROM factory.runtime_attempt WHERE id=${attemptID}`;
    expect((await controller.start(f.project, f.editor, f.workspace))?.id).toBe(attemptID);
    expect((await controller.start(f.project, f.owner, f.workspace))?.id).toBe(attemptID);
    await expect(controller.start(f.project, f.viewer, f.workspace)).rejects.toThrow(
      "observation only",
    );
    expect(
      await f.database
        .client`SELECT id FROM factory.development_workspace WHERE project_id=${f.project}`,
    ).toHaveLength(1);
    expect(
      await f.database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${f.project}`,
    ).toHaveLength(1);
    const [retained] = await f.database
      .client`SELECT generation,created_by,parent_connector_token_hash,state FROM factory.runtime_attempt WHERE id=${attemptID}`;
    expect(retained).toMatchObject({
      generation: "1",
      created_by: f.owner,
      parent_connector_token_hash: original?.["parent_connector_token_hash"],
      state: "ready",
    });
  } finally {
    await f.dispose();
  }
}, 30000);
