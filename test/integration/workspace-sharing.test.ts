import { expect, test } from "bun:test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { workspaceWriteAuthorityIn } from "../../apps/factory/src/access/change-writer";
import { workspaceAuthorityIn } from "../../apps/factory/src/access/workspace";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { factoryProcess } from "../fixtures/factory-process";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

async function fixture() {
  const process = await factoryProcess();
  const database = process.connect();
  const owner = crypto.randomUUID();
  const editor = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  const project = crypto.randomUUID();
  const workspace = personalWorkspaceIdentity(project, owner).workspaceID;
  for (const id of [owner, editor, viewer, contributor])
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Sharing fixture',${`${id}@factory.invalid`})`;
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${project},${`sharing-${project}`},'Workspace sharing','https://github.com/example/project','main','.devcontainer/devcontainer.json',${owner})`;
  for (const id of [owner, editor, viewer, contributor])
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${project},${id},${id === contributor ? "product-contributor" : "developer"},${owner})`;
  await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
    VALUES(${workspace},${project},'personal',${owner},'main',${"a".repeat(40)},${owner})`;
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
  return {
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
    async dispose() {
      await database.client.end({ timeout: 2 });
      await process.dispose();
    },
  };
}

test("personal source is private until shared and grants never elevate Project authority", async () => {
  const f = await fixture();
  try {
    expect((await f.read(f.owner)).permission).toBe("collaborate");
    await expect(f.read(f.editor)).rejects.toThrow("Workspace not found");
    await expect(f.grant(f.contributor, "collaborate")).rejects.toThrow(
      "Developer access required",
    );
    expect(
      (await f.sharing.view(f.owner, f.workspace)).members.map((m) => m.userID).sort(),
    ).toEqual([f.editor, f.viewer].sort());
    await f.grant(f.viewer, "observe");
    expect((await f.read(f.viewer)).permission).toBe("observe");
    await expect(f.write(f.viewer)).rejects.toThrow("observation only");
    await f.grant(f.editor, "collaborate");
    expect((await f.write(f.editor)).ownerID).toBe(f.owner);
    await expect(f.sharing.view(f.editor, f.workspace)).rejects.toThrow("Only the Workspace owner");
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.project} AND user_id=${f.editor}`;
    await expect(f.write(f.editor)).rejects.toThrow("Developer access required");
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
    >`SELECT count(*)::int AS count FROM factory.workspace_share_decision`;
    expect(count?.count).toBe(2);
  } finally {
    await f.dispose();
  }
}, 30000);

test("a kick revokes only the member's access and preserves shared runtime identity and state", async () => {
  const f = await fixture();
  const attemptID = crypto.randomUUID();
  try {
    await f.grant(f.editor, "collaborate");
    await f.grant(f.viewer, "observe");
    await f.database
      .client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${attemptID},${f.project},${f.workspace},1,${"a".repeat(40)},'ready','parent-fixture','child-fixture',now(),${f.owner})`;
    const access = createAccessController(f.database);
    await access.requireRuntime(f.editor, attemptID, "ide");
    const [before] = await f.database
      .client`SELECT * FROM factory.runtime_attempt WHERE id=${attemptID}`;
    const result = await f.grant(f.editor, null, 1);
    expect(result.permission).toBeNull();
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
    >`SELECT count(*)::int AS count FROM factory.workspace_share_decision WHERE access_reconciled_at IS NULL`;
    expect(pending?.count).toBe(0);
  } finally {
    await f.dispose();
  }
}, 30000);

test("an invited collaborator connects to the retained owner's compute, not a second personal Workspace", async () => {
  const restore = installOwnedRuntimeConfiguration();
  const f = await fixture();
  const attemptID = crypto.randomUUID();
  try {
    await f.grant(f.editor, "collaborate");
    await f.grant(f.viewer, "observe");
    await f.database
      .client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${attemptID},${f.project},${f.workspace},1,${"a".repeat(40)},'ready','retained-parent','retained-child',now(),${f.owner})`;
    const hub = new RuntimeHub(async () => {});
    const controller = createRuntimeController(f.database, hub, "shared-runtime-fixture", {
      async prepareExecution() {
        throw new Error("An existing shared attempt must not create Source");
      },
    });
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
      .client`SELECT generation,created_by,parent_connector_token_hash,child_connector_token_hash,state FROM factory.runtime_attempt WHERE id=${attemptID}`;
    expect(retained).toMatchObject({
      generation: "1",
      created_by: f.owner,
      parent_connector_token_hash: "retained-parent",
      child_connector_token_hash: "retained-child",
      state: "ready",
    });
  } finally {
    await f.dispose();
    restore();
  }
}, 30000);
