import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { createWorkspaceCollaboration } from "../../apps/factory/src/workspace/collaboration";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { factoryProcess } from "../fixtures/factory-process";

const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const version = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const process = await factoryProcess(),
    database = process.connect();
  const owner = crypto.randomUUID(),
    guest = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    workspaceID = crypto.randomUUID();
  const sessions = new Map<string, string>();
  for (const [id, name] of [
    [owner, "Owner"],
    [guest, "Guest"],
  ] as const) {
    await database.client`INSERT INTO auth."user"(id,name,email)VALUES(${id},${name},${`${id}@factory.invalid`})`;
    const sessionID = crypto.randomUUID();
    sessions.set(id, sessionID);
    await database.client`INSERT INTO auth.session(id,token,user_id,expires_at,created_at,updated_at,login_method,authenticated_at)
      VALUES(${sessionID},${crypto.randomUUID()},${id},now()+interval '1 hour',now(),now(),'password',now())`;
  }
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${`shared-${projectID}`},'Shared editor','https://github.com/example/project','main','.devcontainer/devcontainer.json',${owner})`;
  for (const id of [owner, guest])
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)VALUES(${projectID},${id},'developer',${owner})`;
  await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by,collaboration_enabled)
    VALUES(${workspaceID},${projectID},'personal',${owner},'main',${"a".repeat(40)},${owner},true)`;
  const files = new Map([["file.txt", "original\n"]]);
  let blockedRead:
    | { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    | undefined;
  const source = {
    async forward(_workspaceID: string, _userID: string, action: string, request: Request) {
      const input = (await request.json()) as { path: string; content?: string; version?: string };
      const previous = files.get(input.path);
      if (action === "read" && blockedRead) {
        const gate = blockedRead;
        blockedRead = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      if (previous === undefined && !(action === "write" && input.version === ""))
        return new Response(null, { status: 404 });
      if (action === "write") {
        if ((previous === undefined ? "" : version(previous)) !== input.version)
          return new Response(null, { status: 409 });
        files.set(input.path, Buffer.from(input.content ?? "", "base64").toString());
      }
      const text = files.get(input.path) ?? "";
      return Response.json({
        kind: "file",
        size: Buffer.byteLength(text),
        mtime: 1,
        ctime: 1,
        version: version(text),
        content: Buffer.from(text).toString("base64"),
      });
    },
  };
  let collaboration = createWorkspaceCollaboration(database, source);
  const sharing = createWorkspaceSharing(database, (workspace, user) =>
    collaboration.revoke(workspace, user),
  );
  await sharing.decide(owner, {
    commandID: crypto.randomUUID(),
    workspaceID,
    userID: guest,
    permission: "collaborate",
    expectedVersion: 0,
  });
  const actor = (userID: string, kind: "person" | "agent" = "person") => ({
    userID,
    sessionID: sessions.get(userID) ?? "",
    kind,
  });
  const clients = new Map<Y.Doc, { participantID: string; vector: Uint8Array | undefined }>();
  async function sync(userID: string, doc: Y.Doc, push = true) {
    let client = clients.get(doc);
    if (!client) {
      client = { participantID: crypto.randomUUID(), vector: undefined };
      clients.set(doc, client);
    }
    const update = client.vector && push ? Y.encodeStateAsUpdate(doc, client.vector) : undefined;
    const result = await collaboration.sync(actor(userID), workspaceID, {
      path: "file.txt",
      participantID: client.participantID,
      clientID: doc.clientID,
      vector: encoded(Y.encodeStateVector(doc)),
      ...(update && update.length > 2 ? { update: encoded(update) } : {}),
    });
    Y.applyUpdate(doc, Buffer.from(result.update, "base64"));
    client.vector = Buffer.from(result.vector, "base64");
    return result;
  }
  return {
    database,
    owner,
    guest,
    workspaceID,
    files,
    sharing,
    actor,
    sync,
    get collaboration() {
      return collaboration;
    },
    blockNextRead() {
      const gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      blockedRead = gate;
      return gate;
    },
    async restart() {
      await collaboration.close();
      collaboration = createWorkspaceCollaboration(database, source);
    },
    async dispose() {
      await collaboration.close();
      for (const doc of clients.keys()) doc.destroy();
      await database.client.end({ timeout: 2 });
      await process.dispose();
    },
  };
}

test("concurrent Yjs editor buffers converge and survive the owner's disconnect and Factory restart", async () => {
  const f = await fixture();
  const owner = new Y.Doc(),
    guest = new Y.Doc();
  try {
    await f.sync(f.owner, owner);
    await f.sync(f.guest, guest);
    owner.getText("text").insert(0, "owner ");
    guest.getText("text").insert(0, "guest ");
    await Promise.all([f.sync(f.owner, owner), f.sync(f.guest, guest)]);
    await f.sync(f.owner, owner);
    await f.sync(f.guest, guest);
    expect(owner.getText("text").toString()).toBe(guest.getText("text").toString());
    expect(owner.getText("text").toString()).toContain("owner ");
    expect(owner.getText("text").toString()).toContain("guest ");
    expect(f.files.get("file.txt")).toBe("original\n");
    await f.restart();
    guest.getText("text").insert(guest.getText("text").length, "after disconnect\n");
    const observed = await f.sync(f.guest, guest);
    expect(observed.dirty).toBe(true);
    await f.collaboration.save(f.guest, f.workspaceID, {
      path: "file.txt",
      revision: observed.revision,
    });
    expect(f.files.get("file.txt")).toBe(guest.getText("text").toString());
  } finally {
    await f.dispose();
  }
}, 30000);

test("external disk writes conflict without discarding the shared unsaved document", async () => {
  const f = await fixture();
  const doc = new Y.Doc();
  try {
    await f.sync(f.owner, doc);
    doc.getText("text").insert(0, "unsaved ");
    await f.sync(f.owner, doc);
    f.files.set("file.txt", "external formatter\n");
    const conflict = await f.sync(f.owner, doc);
    expect(conflict.conflict).toBe(true);
    expect(doc.getText("text").toString()).toContain("unsaved ");
    await expect(
      f.collaboration.save(f.owner, f.workspaceID, {
        path: "file.txt",
        revision: conflict.revision,
      }),
    ).rejects.toThrow("outside shared editing");
    expect(f.files.get("file.txt")).toBe("external formatter\n");
    await expect(f.collaboration.assertSaved(f.workspaceID)).rejects.toThrow("Save or resolve");
    const observed = await f.collaboration.read(f.owner, f.workspaceID, "file.txt");
    const decision = {
      requestID: crypto.randomUUID(),
      path: "file.txt",
      revision: observed.revision,
      diskVersion: observed.diskVersion,
      choice: "keep-shared" as const,
    };
    const resolved = await f.collaboration.resolve(f.owner, f.workspaceID, decision);
    expect(await f.collaboration.resolve(f.owner, f.workspaceID, decision)).toEqual(resolved);
    expect(f.files.get("file.txt")).toBe("external formatter\n");
    const ready = await f.collaboration.read(f.owner, f.workspaceID, "file.txt");
    await f.collaboration.save(f.owner, f.workspaceID, {
      path: "file.txt",
      revision: ready.revision,
    });
    expect(f.files.get("file.txt")).toContain("unsaved ");
    await f.collaboration.assertSaved(f.workspaceID);
  } finally {
    await f.dispose();
  }
}, 30000);

test("observers and kicked collaborators cannot submit document updates and agent edits keep identity", async () => {
  const f = await fixture();
  const doc = new Y.Doc();
  try {
    await f.sync(f.guest, doc);
    const before = await f.collaboration.read(f.owner, f.workspaceID, "file.txt");
    await f.collaboration.edit(f.actor(f.owner, "agent"), f.workspaceID, {
      path: "file.txt",
      revision: before.revision,
      edits: [{ offset: 0, deleteCount: 0, text: "agent " }],
    });
    const peers = await f.collaboration.participants(f.workspaceID, f.owner);
    expect(peers.some((peer) => peer.kind === "agent" && peer.name === "Owner · local agent")).toBe(
      true,
    );
    await expect(
      f.collaboration.edit(f.actor(f.owner, "agent"), f.workspaceID, {
        path: "file.txt",
        revision: before.revision,
        edits: [{ offset: 0, deleteCount: 0, text: "again " }],
      }),
    ).rejects.toThrow("changed");
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: "observe",
      expectedVersion: 1,
    });
    doc.getText("text").insert(0, "forbidden ");
    await expect(f.sync(f.guest, doc)).rejects.toThrow("observation only");
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: null,
      expectedVersion: 2,
    });
    await expect(f.sync(f.guest, doc, false)).rejects.toThrow("Workspace not found");
    expect((await f.collaboration.read(f.owner, f.workspaceID, "file.txt")).content).not.toContain(
      "forbidden ",
    );
  } finally {
    await f.dispose();
  }
}, 30000);

test("unsent client edits survive an external change and an externally deleted file can be explicitly restored", async () => {
  const f = await fixture();
  const doc = new Y.Doc();
  try {
    await f.sync(f.owner, doc);
    doc.getText("text").insert(0, "offline draft ");
    f.files.set("file.txt", "external source\n");
    const changed = await f.sync(f.owner, doc);
    expect(changed.conflict).toBe(true);
    expect(doc.getText("text").toString()).toBe("offline draft original\n");
    f.files.delete("file.txt");
    const missing = await f.collaboration.read(f.owner, f.workspaceID, "file.txt");
    expect(missing.diskMissing).toBe(true);
    expect(missing.content).toContain("offline draft");
    await f.collaboration.resolve(f.owner, f.workspaceID, {
      requestID: crypto.randomUUID(),
      path: "file.txt",
      revision: missing.revision,
      diskVersion: missing.diskVersion,
      choice: "keep-shared",
    });
    const preserved = await f.collaboration.read(f.owner, f.workspaceID, "file.txt");
    await f.collaboration.save(f.owner, f.workspaceID, {
      path: "file.txt",
      revision: preserved.revision,
    });
    expect(f.files.get("file.txt")).toBe("offline draft original\n");
  } finally {
    await f.dispose();
  }
}, 30000);

test("revocation while a document is being read prevents the admitted update from being persisted later", async () => {
  const f = await fixture();
  const doc = new Y.Doc();
  try {
    await f.sync(f.guest, doc);
    doc.getText("text").insert(0, "revoked edit ");
    const gate = f.blockNextRead();
    const pending = f.sync(f.guest, doc);
    await gate.entered.promise;
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: null,
      expectedVersion: 1,
    });
    gate.release.resolve();
    await expect(pending).rejects.toThrow("Workspace not found");
    expect((await f.collaboration.read(f.owner, f.workspaceID, "file.txt")).content).toBe(
      "original\n",
    );
  } finally {
    await f.dispose();
  }
}, 30000);
