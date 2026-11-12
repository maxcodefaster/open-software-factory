import { createHash } from "node:crypto";
import * as Y from "yjs";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { workspaceWriteAuthorityIn, lockChangeWriterIn } from "../access/change-writer";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { createWorkspaceSourceController } from "./source-controller";

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part === ".git" ||
            part.startsWith(".factory-"),
        ),
    "Invalid shared document path",
  );
const syncInput = z.strictObject({
  path: pathSchema,
  participantID: z.uuid(),
  clientID: z.number().int().min(0).max(0xffffffff),
  vector: z.string().max(131072).default(""),
  update: z
    .string()
    .max(6 << 20)
    .optional(),
  cursor: z
    .object({ anchor: z.string().max(2048), head: z.string().max(2048) })
    .nullable()
    .optional(),
});
type Actor = {
  userID: string;
  sessionID: string;
  kind: "person" | "agent";
  oauthClientID?: string;
};
type DocumentRow = { state: Uint8Array; diskVersion: string; dirty: boolean; conflict: boolean };
type Presence = {
  oauthClientID?: string;
  workspaceID: string;
  path: string;
  userID: string;
  sessionID: string;
  kind: "person" | "agent";
  participantID: string;
  clientID: number;
  name: string;
  color: string;
  cursor: { anchor: string; head: string } | null;
  seen: number;
};
const colors = ["#375dc5", "#a23c69", "#137363", "#8f5a12", "#7b46b3", "#a44032"];
const revision = (doc: Y.Doc) =>
  createHash("sha256").update(Y.encodeStateAsUpdate(doc)).digest("hex");

/** Yjs owns document merging and relative cursor positions. Factory owns identity, access and saved source. */
export function createWorkspaceCollaboration(
  database: ReturnType<typeof createDatabase>,
  sources: Pick<ReturnType<typeof createWorkspaceSourceController>, "forward">,
) {
  const presence = new Map<string, Presence>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const authorizeIn = async (
    sql: AgentTurnTransaction,
    workspaceID: string,
    userID: string,
    write = false,
  ) => {
    const [workspace] = await sql<
      { changeID: string | null }[]
    >`SELECT change_id AS "changeID" FROM factory.development_workspace WHERE id=${workspaceID}`;
    if (workspace?.changeID) await lockChangeWriterIn(sql, workspace.changeID);
    const access = await workspaceAuthorityIn(sql, workspaceID, userID, write);
    if (!access.collaborative)
      throw new CommandError("conflict", "Enable shared editing for this Workspace first");
    if (write) await workspaceWriteAuthorityIn(sql, workspaceID, userID);
    let canWrite = false;
    if (access.permission === "collaborate") {
      try {
        await workspaceWriteAuthorityIn(sql, workspaceID, userID);
        canWrite = true;
      } catch (cause) {
        if (!(cause instanceof CommandError) || cause.code !== "conflict") throw cause;
      }
    }
    return { ...access, canWrite };
  };
  const authorize = (workspaceID: string, userID: string, write = false) =>
    database.client.begin((sql) => authorizeIn(sql, workspaceID, userID, write));
  async function locked<T>(workspaceID: string, path: string, run: () => Promise<T>) {
    if (closed) throw new CommandError("unavailable", "Factory is stopping");
    const task = (async () => {
      const lock = database.coordination();
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`shared-document:${workspaceID}:${path}`}))`;
        return await run();
      } finally {
        await lock`SELECT pg_advisory_unlock_all()`.catch(() => {});
        await lock.end({ timeout: 1 });
      }
    })();
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
    }
  }
  async function disk(workspaceID: string, userID: string, path: string) {
    const response = await sources.forward(
      workspaceID,
      userID,
      "read",
      new Request("http://factory.internal/shared", {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
    );
    if (!response.ok)
      throw new CommandError(
        response.status === 404 ? "not-found" : "unavailable",
        "Shared document source is unavailable",
      );
    const file = z
      .object({
        version: z.string(),
        content: z.string().default(""),
        kind: z.literal("file"),
        size: z.number(),
        mtime: z.number(),
        ctime: z.number(),
      })
      .parse(await response.json());
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > 2 << 20 || bytes.includes(0))
      throw new CommandError("invalid", "Shared editing supports UTF-8 text files up to 2 MiB");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { file, content };
  }
  async function load(workspaceID: string, userID: string, path: string, incomingEdits = false) {
    const [row] = await database.client<
      DocumentRow[]
    >`SELECT y_state AS state,disk_version AS "diskVersion",dirty,conflict
      FROM factory.workspace_shared_document WHERE workspace_id=${workspaceID} AND path=${path}`;
    const current = await disk(workspaceID, userID, path).catch((cause) => {
      if (row && cause instanceof CommandError && cause.code === "not-found")
        return {
          file: { version: "", content: "", kind: "file" as const, size: 0, mtime: 0, ctime: 0 },
          content: "",
          missing: true,
        };
      throw cause;
    });
    const doc = new Y.Doc();
    if (row) Y.applyUpdate(doc, row.state);
    else doc.getText("text").insert(0, current.content);
    const text = doc.getText("text");
    let dirty = row?.dirty ?? false,
      conflict = row?.conflict ?? false,
      diskVersion = row?.diskVersion ?? current.file.version;
    if (current.file.version !== diskVersion) {
      if (text.toString() === current.content) {
        dirty = false;
        conflict = false;
        diskVersion = current.file.version;
      } else if (dirty || incomingEdits) conflict = true;
      else {
        doc.transact(() => {
          text.delete(0, text.length);
          text.insert(0, current.content);
        });
        diskVersion = current.file.version;
        conflict = false;
      }
    }
    return {
      doc,
      dirty,
      conflict,
      diskVersion,
      file: current.file,
      missing: "missing" in current && current.missing,
    };
  }
  async function persist(
    workspaceID: string,
    path: string,
    value: Awaited<ReturnType<typeof load>>,
    sql: AgentTurnTransaction | typeof database.client = database.client,
  ) {
    const state = Buffer.from(Y.encodeStateAsUpdate(value.doc));
    if (state.length > 8 << 20 || Buffer.byteLength(value.doc.getText("text").toString()) > 2 << 20)
      throw new CommandError(
        "invalid",
        "Shared document exceeds its size bound. Keep your local buffer.",
      );
    await sql`INSERT INTO factory.workspace_shared_document(workspace_id,path,y_state,disk_version,dirty,conflict)
      VALUES(${workspaceID},${path},${state},${value.diskVersion},${value.dirty},${value.conflict})
      ON CONFLICT(workspace_id,path) DO UPDATE SET y_state=EXCLUDED.y_state,disk_version=EXCLUDED.disk_version,
        dirty=EXCLUDED.dirty,conflict=EXCLUDED.conflict,updated_at=now()`;
  }
  async function participants(workspaceID: string, userID: string, path?: string) {
    await database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, userID));
    for (const [key, peer] of presence) if (peer.seen < Date.now() - 30_000) presence.delete(key);
    const peers = [...presence.values()].filter(
      (peer) => peer.workspaceID === workspaceID && (!path || peer.path === path),
    );
    const allowed = new Map<string, boolean>();
    for (const peer of peers) {
      const key = `${peer.userID}:${peer.sessionID}`;
      if (!allowed.has(key)) {
        const [session] =
          await database.client`SELECT id FROM auth.session WHERE id=${peer.sessionID} AND user_id=${peer.userID} AND expires_at>now()`;
        try {
          await database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, peer.userID));
          allowed.set(key, Boolean(session));
        } catch {
          allowed.set(key, false);
        }
      }
    }
    return peers
      .filter((peer) => allowed.get(`${peer.userID}:${peer.sessionID}`))
      .map(({ sessionID: _session, seen: _seen, workspaceID: _workspace, ...peer }) => peer);
  }
  async function touch(
    workspaceID: string,
    path: string,
    actor: Actor,
    input: z.infer<typeof syncInput>,
  ) {
    for (const [id, peer] of presence) if (peer.seen < Date.now() - 30_000) presence.delete(id);
    const previous = presence.get(input.participantID);
    if (
      !previous &&
      [...presence.values()].filter((peer) => peer.workspaceID === workspaceID).length >= 256
    )
      throw new CommandError("unavailable", "Workspace participant limit reached");
    if (
      previous &&
      (previous.userID !== actor.userID ||
        previous.sessionID !== actor.sessionID ||
        previous.oauthClientID !== actor.oauthClientID)
    )
      throw new CommandError("conflict", "Participant identity belongs to another connection");
    if (
      [...presence.values()].some(
        (peer) =>
          peer.workspaceID === workspaceID &&
          peer.path === path &&
          peer.clientID === input.clientID &&
          peer.participantID !== input.participantID &&
          peer.seen > Date.now() - 30_000,
      )
    )
      throw new CommandError("conflict", "Document client identity is already connected");
    const [person] = await database.client<
      { name: string }[]
    >`SELECT left(name,160) AS name FROM auth."user" WHERE id=${actor.userID}`;
    const [client] = actor.oauthClientID
      ? await database.client<
          { name: string | null }[]
        >`SELECT left(name,80) AS name FROM auth."oauthClient" WHERE "clientId"=${actor.oauthClientID}`
      : [];
    presence.set(input.participantID, {
      workspaceID,
      path,
      ...actor,
      participantID: input.participantID,
      clientID: input.clientID,
      name: `${person?.name ?? "Developer"}${actor.kind === "agent" ? ` · ${client?.name ?? "local agent"}` : ""}`,
      color:
        colors[
          parseInt(createHash("sha256").update(actor.userID).digest("hex").slice(0, 8), 16) %
            colors.length
        ] ??
        colors[0] ??
        "#375dc5",
      cursor: input.cursor ?? null,
      seen: Date.now(),
    });
  }
  return {
    async enable(userID: string, workspaceID: string, commandID: string) {
      z.uuid().parse(commandID);
      z.uuid().parse(workspaceID);
      return database.client.begin(async (sql) => {
        const access = await workspaceWriteAuthorityIn(sql, workspaceID, userID);
        if (access.kind === "personal" && access.ownerID !== userID)
          throw new CommandError(
            "forbidden",
            "Only the owner enables personal Workspace collaboration",
          );
        const [previous] = await sql<
          { workspaceID: string; actorID: string }[]
        >`SELECT workspace_id AS "workspaceID",actor_id AS "actorID" FROM factory.workspace_collaboration_decision WHERE id=${commandID}`;
        if (previous && (previous.workspaceID !== workspaceID || previous.actorID !== userID))
          throw new CommandError("conflict", "Collaboration decision identity differs");
        await sql`INSERT INTO factory.workspace_collaboration_decision(id,workspace_id,actor_id) VALUES(${commandID},${workspaceID},${userID}) ON CONFLICT(id) DO NOTHING`;
        await sql`UPDATE factory.development_workspace SET collaboration_enabled=true WHERE id=${workspaceID}`;
        return { workspaceID, collaborative: true };
      });
    },
    async sync(actor: Actor, workspaceID: string, raw: unknown) {
      const input = syncInput.parse(raw);
      if (input.cursor) {
        try {
          Y.decodeRelativePosition(Buffer.from(input.cursor.anchor, "base64"));
          Y.decodeRelativePosition(Buffer.from(input.cursor.head, "base64"));
        } catch {
          throw new CommandError("invalid", "Shared cursor positions are invalid");
        }
      }
      return locked(workspaceID, input.path, async () => {
        const access = await authorize(workspaceID, actor.userID, Boolean(input.update));
        const value = await load(workspaceID, actor.userID, input.path, Boolean(input.update));
        try {
          if (input.update) {
            const before = value.doc.getText("text").toString();
            Y.applyUpdate(value.doc, Buffer.from(input.update, "base64"));
            if (value.doc.getText("text").toString() !== before) value.dirty = true;
          }
          await database.client.begin(async (sql) => {
            await authorizeIn(sql, workspaceID, actor.userID, Boolean(input.update));
            await persist(workspaceID, input.path, value, sql);
          });
          await touch(workspaceID, input.path, actor, input);
          await authorize(workspaceID, actor.userID);
          return {
            update: Buffer.from(
              Y.encodeStateAsUpdate(
                value.doc,
                input.vector ? Buffer.from(input.vector, "base64") : undefined,
              ),
            ).toString("base64"),
            vector: Buffer.from(Y.encodeStateVector(value.doc)).toString("base64"),
            revision: revision(value.doc),
            dirty: value.dirty,
            conflict: value.conflict,
            diskVersion: value.file.version,
            diskMissing: value.missing,
            canWrite: access.canWrite,
            participants: await participants(workspaceID, actor.userID, input.path),
            participantID: input.participantID,
          };
        } finally {
          value.doc.destroy();
        }
      });
    },
    async save(userID: string, workspaceID: string, raw: unknown) {
      const input = z
        .strictObject({ path: pathSchema, revision: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(raw);
      return locked(workspaceID, input.path, async () => {
        await authorize(workspaceID, userID, true);
        const value = await load(workspaceID, userID, input.path);
        try {
          if (value.conflict)
            throw new CommandError(
              "conflict",
              "Saved source changed outside shared editing. Your shared buffer is retained. Resolve the disk conflict before saving.",
            );
          if (revision(value.doc) !== input.revision)
            throw new CommandError(
              "conflict",
              "Shared edits arrived before Save. Synchronize and save again.",
            );
          const response = await sources.forward(
            workspaceID,
            userID,
            "write",
            new Request("http://factory.internal/shared-save", {
              method: "POST",
              body: JSON.stringify({
                path: input.path,
                version: value.diskVersion,
                content: Buffer.from(value.doc.getText("text").toString()).toString("base64"),
              }),
            }),
            true,
          );
          if (!response.ok)
            throw new CommandError(
              response.status === 409 ? "conflict" : "unavailable",
              "Shared Save was not confirmed. Your buffer is retained.",
            );
          const file = z
            .object({ version: z.string() })
            .passthrough()
            .parse(await response.json());
          value.diskVersion = file.version;
          value.dirty = false;
          value.conflict = false;
          await persist(workspaceID, input.path, value);
          return file;
        } finally {
          value.doc.destroy();
        }
      });
    },
    async read(userID: string, workspaceID: string, path: string) {
      pathSchema.parse(path);
      return locked(workspaceID, path, async () => {
        await authorize(workspaceID, userID);
        const value = await load(workspaceID, userID, path);
        try {
          await persist(workspaceID, path, value);
          return {
            path,
            content: value.doc.getText("text").toString(),
            savedContent: Buffer.from(value.file.content, "base64").toString("utf8"),
            diskVersion: value.file.version,
            diskMissing: value.missing,
            revision: revision(value.doc),
            dirty: value.dirty,
            conflict: value.conflict,
          };
        } finally {
          value.doc.destroy();
        }
      });
    },
    async edit(actor: Actor, workspaceID: string, raw: unknown) {
      const input = z
        .strictObject({
          path: pathSchema,
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          edits: z
            .array(
              z.strictObject({
                offset: z.number().int().nonnegative(),
                deleteCount: z.number().int().nonnegative(),
                text: z.string().max(65536),
              }),
            )
            .min(1)
            .max(100),
        })
        .parse(raw);
      return locked(workspaceID, input.path, async () => {
        await authorize(workspaceID, actor.userID, true);
        const value = await load(workspaceID, actor.userID, input.path);
        try {
          if (revision(value.doc) !== input.revision)
            throw new CommandError(
              "conflict",
              "Shared document changed. Read it again before editing.",
            );
          const text = value.doc.getText("text");
          for (const edit of input.edits) {
            if (edit.offset + edit.deleteCount > text.length)
              throw new CommandError("invalid", "Shared edit exceeds the document");
            text.delete(edit.offset, edit.deleteCount);
            text.insert(edit.offset, edit.text);
          }
          value.dirty = true;
          await database.client.begin(async (sql) => {
            await authorizeIn(sql, workspaceID, actor.userID, true);
            await persist(workspaceID, input.path, value, sql);
          });
          const previous = [...presence.values()].find(
            (peer) =>
              peer.workspaceID === workspaceID &&
              peer.path === input.path &&
              peer.sessionID === actor.sessionID &&
              peer.oauthClientID === actor.oauthClientID &&
              peer.kind === "agent",
          );
          const position = Y.createRelativePositionFromTypeIndex(text, text.length);
          const encoded = Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
          await touch(workspaceID, input.path, actor, {
            path: input.path,
            participantID: previous?.participantID ?? crypto.randomUUID(),
            clientID: previous?.clientID ?? value.doc.clientID,
            vector: "",
            cursor: { anchor: encoded, head: encoded },
          });
          return { path: input.path, revision: revision(value.doc), dirty: true };
        } finally {
          value.doc.destroy();
        }
      });
    },
    async resolve(userID: string, workspaceID: string, raw: unknown) {
      const input = z
        .strictObject({
          requestID: z.uuid(),
          path: pathSchema,
          revision: z.string(),
          diskVersion: z.string(),
          choice: z.enum(["keep-shared", "use-saved"]),
        })
        .parse(raw);
      return locked(workspaceID, input.path, async () => {
        await authorize(workspaceID, userID, true);
        const [previous] = await database.client<
          {
            actorID: string;
            workspaceID: string;
            path: string;
            choice: string;
            revision: string;
            diskVersion: string;
            result: unknown;
          }[]
        >`
          SELECT actor_id AS "actorID",workspace_id AS "workspaceID",path,choice,document_revision AS revision,disk_version AS "diskVersion",result FROM factory.shared_document_resolution WHERE id=${input.requestID}`;
        if (previous) {
          if (
            previous.actorID !== userID ||
            previous.workspaceID !== workspaceID ||
            previous.path !== input.path ||
            previous.choice !== input.choice ||
            previous.revision !== input.revision ||
            previous.diskVersion !== input.diskVersion
          )
            throw new CommandError(
              "conflict",
              "Resolution identity already records another decision",
            );
          return previous.result;
        }
        const value = await load(workspaceID, userID, input.path);
        try {
          if (revision(value.doc) !== input.revision || value.file.version !== input.diskVersion)
            throw new CommandError(
              "conflict",
              "Shared or saved source changed. Compare the current versions before deciding.",
            );
          if (input.choice === "use-saved") {
            const text = value.doc.getText("text");
            value.doc.transact(() => {
              text.delete(0, text.length);
              text.insert(0, Buffer.from(value.file.content, "base64").toString("utf8"));
            });
          }
          value.diskVersion = value.file.version;
          value.conflict = false;
          value.dirty = input.choice === "keep-shared";
          const result = {
            path: input.path,
            revision: revision(value.doc),
            dirty: value.dirty,
            conflict: false,
          };
          await database.client.begin(async (sql) => {
            await authorizeIn(sql, workspaceID, userID, true);
            await persist(workspaceID, input.path, value, sql);
            await sql`INSERT INTO factory.shared_document_resolution(id,workspace_id,path,actor_id,choice,document_revision,disk_version,result)
              VALUES(${input.requestID},${workspaceID},${input.path},${userID},${input.choice},${input.revision},${input.diskVersion},${JSON.stringify(result)}::text::jsonb)`;
          });
          return result;
        } finally {
          value.doc.destroy();
        }
      });
    },
    participants,
    revoke(workspaceID: string, userID: string) {
      for (const [id, peer] of presence)
        if (peer.workspaceID === workspaceID && peer.userID === userID) presence.delete(id);
    },
    async assertSaved(workspaceID: string) {
      const [dirty] =
        await database.client`SELECT path FROM factory.workspace_shared_document WHERE workspace_id=${workspaceID} AND (dirty OR conflict) LIMIT 1`;
      if (dirty)
        throw new CommandError(
          "conflict",
          "Save or resolve shared documents before submitting the saved checkout.",
        );
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      presence.clear();
    },
  };
}
