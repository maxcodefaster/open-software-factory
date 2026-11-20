import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { createWorkspaceCollaboration } from "../../apps/factory/src/workspace/collaboration";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import {
  developmentWorkspace,
  workspaceCollaborationDecision,
  workspaceSharedDocument,
} from "../../packages/db/src/schema";
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
  let writeBoundary: "disk CAS" | "lost Save acknowledgement" | undefined;
  let blockedRead:
    | { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    | undefined;
  const source = {
    async forward(_workspaceID: string, _userID: string, action: string, request: Request) {
      const input = (await request.json()) as { path: string; content?: string; version?: string };
      const boundary = action === "write" ? writeBoundary : undefined;
      if (action === "write") writeBoundary = undefined;
      if (boundary === "disk CAS") files.set(input.path, "concurrent shell write\n");
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
        if (boundary === "lost Save acknowledgement")
          throw Error("Owned Save acknowledgement lost");
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
    projectID,
    workspaceID,
    files,
    interruptNextWrite(boundary: NonNullable<typeof writeBoundary>) {
      writeBoundary = boundary;
    },
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
    const [stored] = await f.database.db
      .select({ state: workspaceSharedDocument.yState })
      .from(workspaceSharedDocument)
      .where(
        and(
          eq(workspaceSharedDocument.workspaceId, f.workspaceID),
          eq(workspaceSharedDocument.path, "file.txt"),
        ),
      );
    const [native] = await f.database.client<{ hex: string; type: string }[]>`
      SELECT encode(y_state,'hex') AS hex,pg_typeof(y_state)::text AS type
      FROM factory.workspace_shared_document WHERE workspace_id=${f.workspaceID} AND path='file.txt'`;
    expect(native?.type).toBe("bytea");
    expect(Buffer.isBuffer(stored?.state)).toBe(true);
    expect(stored?.state.toString("hex")).toBe(native?.hex);
    const restored = new Y.Doc();
    try {
      if (!stored) throw Error("Persisted Yjs state missing");
      Y.applyUpdate(restored, stored.state);
      expect(restored.getText("text").toString()).toBe(owner.getText("text").toString());
    } finally {
      restored.destroy();
    }
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
    await expect(
      f.collaboration.resolve(f.owner, f.workspaceID, { ...decision, choice: "use-saved" }),
    ).rejects.toThrow("another decision");
    await expect(f.collaboration.resolve(f.guest, f.workspaceID, decision)).rejects.toThrow(
      "another decision",
    );
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

test.each(["disk CAS", "lost Save acknowledgement"] as const)(
  "unconfirmed %s keeps the persisted buffer until disk is observed",
  async (boundary) => {
    const f = await fixture();
    const doc = new Y.Doc();
    try {
      await f.sync(f.owner, doc);
      doc.getText("text").insert(0, "retained draft ");
      const edited = await f.sync(f.owner, doc);
      f.interruptNextWrite(boundary);
      await expect(
        f.collaboration.save(f.owner, f.workspaceID, {
          path: "file.txt",
          revision: edited.revision,
        }),
      ).rejects.toThrow(
        boundary === "disk CAS" ? "Save was not confirmed" : "Save acknowledgement lost",
      );
      const [stored] = await f.database.db
        .select({
          dirty: workspaceSharedDocument.dirty,
          diskVersion: workspaceSharedDocument.diskVersion,
        })
        .from(workspaceSharedDocument)
        .where(eq(workspaceSharedDocument.workspaceId, f.workspaceID));
      expect(stored).toEqual({ dirty: true, diskVersion: version("original\n") });
      await f.restart();
      const observed = await f.collaboration.read(f.owner, f.workspaceID, "file.txt");
      expect(observed.content).toBe("retained draft original\n");
      expect(observed.conflict).toBe(boundary === "disk CAS");
      expect(observed.dirty).toBe(boundary === "disk CAS");
      if (boundary === "disk CAS") {
        expect(f.files.get("file.txt")).toBe("concurrent shell write\n");
        await f.collaboration.resolve(f.owner, f.workspaceID, {
          requestID: crypto.randomUUID(),
          path: "file.txt",
          revision: observed.revision,
          diskVersion: observed.diskVersion,
          choice: "use-saved",
        });
        expect((await f.collaboration.read(f.owner, f.workspaceID, "file.txt")).content).toBe(
          "concurrent shell write\n",
        );
      } else expect(f.files.get("file.txt")).toBe(observed.content);
      await f.collaboration.assertSaved(f.workspaceID);
    } finally {
      await f.dispose();
    }
  },
  30000,
);

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

test("collaboration enablement retains its exact decision and cannot be rebound to another owner", async () => {
  const f = await fixture();
  const commandID = crypto.randomUUID();
  const otherWorkspaceID = crypto.randomUUID();
  try {
    const result = await f.collaboration.enable(f.owner, f.workspaceID, commandID);
    expect(await f.collaboration.enable(f.owner, f.workspaceID, commandID)).toEqual(result);
    await expect(
      f.collaboration.enable(f.guest, f.workspaceID, crypto.randomUUID()),
    ).rejects.toThrow("Only the owner");
    await f.database.db.insert(developmentWorkspace).values({
      id: otherWorkspaceID,
      projectId: f.projectID,
      kind: "personal",
      ownerUserId: f.guest,
      sourceBranch: "main",
      sourceRevision: "a".repeat(40),
      createdBy: f.guest,
    });
    await expect(f.collaboration.enable(f.guest, otherWorkspaceID, commandID)).rejects.toThrow(
      "decision identity differs",
    );
    expect(await f.database.db.select().from(workspaceCollaborationDecision)).toHaveLength(1);
    const [other] = await f.database.db
      .select({ enabled: developmentWorkspace.collaborationEnabled })
      .from(developmentWorkspace)
      .where(eq(developmentWorkspace.id, otherWorkspaceID));
    expect(other?.enabled).toBe(false);
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
