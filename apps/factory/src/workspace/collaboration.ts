import { and, eq, ne, sql as query } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { auditEvent, developmentWorkspace, workspaceSharedDocument } from "#db/schema";
import { lockChangeWriterIn, workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import {
  applyClientDocumentUpdate,
  applyIndexedDocumentEdits,
  documentRevision,
  encodeDocumentForPersistence,
  formatReadDocumentPayload,
  formatSyncDocumentPayload,
  markDocumentSaved,
  missingDiskDocument,
  prepareDocumentSave,
  readDiskDocument,
  reconcileDocumentWithDisk,
  resolveDocumentConflict,
  type SharedDocumentState,
  sharedDocumentPathSchema,
  sharedEditInputSchema,
  sharedResolveInputSchema,
  sharedSaveInputSchema,
  sharedSyncInputSchema,
  validateSharedCursor,
  writeDiskDocument,
} from "./collaboration-document";
import { type CollaborationActor, CollaborationPresenceRoom } from "./collaboration-presence";
import type { createWorkspaceSourceController } from "./source-controller";

/** Yjs owns document merging and relative cursor positions. Factory owns identity, access and saved source. */
export function createWorkspaceCollaboration(
  database: ReturnType<typeof createDatabase>,
  sources: Pick<ReturnType<typeof createWorkspaceSourceController>, "forward">,
) {
  const room = new CollaborationPresenceRoom(database);
  const pending = new Set<Promise<unknown>>();
  let closed = false;

  const authorizeIn = async (
    sql: DatabaseTransaction,
    workspaceID: string,
    userID: string,
    write = false,
  ) => {
    const [workspace] = await drizzleTransaction(sql)
      .select({ changeID: developmentWorkspace.changeId })
      .from(developmentWorkspace)
      .where(eq(developmentWorkspace.id, workspaceID));
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

  async function load(
    workspaceID: string,
    userID: string,
    path: string,
    incomingEdits = false,
    wakeCompute = true,
  ): Promise<SharedDocumentState> {
    const [row] = await database.db
      .select({
        state: workspaceSharedDocument.yState,
        diskVersion: workspaceSharedDocument.diskVersion,
        syncState: workspaceSharedDocument.syncState,
      })
      .from(workspaceSharedDocument)
      .where(
        and(
          eq(workspaceSharedDocument.workspaceId, workspaceID),
          eq(workspaceSharedDocument.path, path),
        ),
      );
    const current = await readDiskDocument(sources, workspaceID, userID, path, wakeCompute).catch(
      (cause) => {
        if (row && cause instanceof CommandError && cause.code === "not-found")
          return missingDiskDocument();
        throw cause;
      },
    );
    return reconcileDocumentWithDisk(row, current, incomingEdits);
  }

  async function persist(
    workspaceID: string,
    path: string,
    state: SharedDocumentState,
    sql: DatabaseTransaction | typeof database.client = database.client,
  ) {
    const document = encodeDocumentForPersistence(state);
    await drizzleTransaction(sql)
      .insert(workspaceSharedDocument)
      .values({ workspaceId: workspaceID, path, ...document })
      .onConflictDoUpdate({
        target: [workspaceSharedDocument.workspaceId, workspaceSharedDocument.path],
        set: { ...document, updatedAt: query`now()` },
      });
  }

  async function persistAuthorized(
    workspaceID: string,
    userID: string,
    path: string,
    state: SharedDocumentState,
    write: boolean,
    afterPersist?: (sql: DatabaseTransaction) => Promise<void>,
  ) {
    await database.client.begin(async (sql) => {
      await authorizeIn(sql, workspaceID, userID, write);
      await persist(workspaceID, path, state, sql);
      if (afterPersist) await afterPersist(sql);
    });
  }

  async function withLoadedDocument<T>(
    workspaceID: string,
    userID: string,
    path: string,
    options: { write?: boolean; incomingEdits?: boolean; wakeCompute?: boolean },
    run: (loaded: SharedDocumentState, access: Awaited<ReturnType<typeof authorize>>) => Promise<T>,
  ): Promise<T> {
    return locked(workspaceID, path, async () => {
      const access = await authorize(workspaceID, userID, options.write);
      const loaded = await load(
        workspaceID,
        userID,
        path,
        options.incomingEdits,
        options.wakeCompute,
      );
      try {
        return await run(loaded, access);
      } finally {
        loaded.doc.destroy();
      }
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
        const db = drizzleTransaction(sql);
        const dedupeKey = `workspace.collaboration_decision:${commandID}`;
        const [previous] = await db
          .select({ workspaceID: auditEvent.scopeId, actorID: auditEvent.actorId })
          .from(auditEvent)
          .where(eq(auditEvent.dedupeKey, dedupeKey));
        if (previous && (previous.workspaceID !== workspaceID || previous.actorID !== userID))
          throw new CommandError("conflict", "Collaboration decision identity differs");
        await db
          .insert(auditEvent)
          .values({
            id: commandID,
            kind: "workspace.collaboration_decision",
            scopeType: "workspace",
            scopeId: workspaceID,
            dedupeKey,
            actorId: userID,
            payload: { commandId: commandID },
          })
          .onConflictDoNothing();
        await db
          .update(developmentWorkspace)
          .set({ collaborationEnabled: true })
          .where(eq(developmentWorkspace.id, workspaceID));
        return { workspaceID, collaborative: true };
      });
    },
    async sync(actor: CollaborationActor, workspaceID: string, raw: unknown) {
      const input = sharedSyncInputSchema.parse(raw);
      validateSharedCursor(input.cursor);
      // The editor polls for remote edits/presence without a user action.
      // Preserve its buffer during Pause instead of turning every poll into Resume.
      return withLoadedDocument(
        workspaceID,
        actor.userID,
        input.path,
        { write: Boolean(input.update), incomingEdits: Boolean(input.update), wakeCompute: false },
        async (loaded, access) => {
          const next = input.update ? applyClientDocumentUpdate(loaded, input.update) : loaded;
          await persistAuthorized(
            workspaceID,
            actor.userID,
            input.path,
            next,
            Boolean(input.update),
          );
          await room.touch(workspaceID, input.path, actor, input);
          await authorize(workspaceID, actor.userID);
          return {
            ...formatSyncDocumentPayload(next, input.vector),
            canWrite: access.canWrite,
            participants: await room.participants(workspaceID, actor.userID, input.path),
            participantID: input.participantID,
          };
        },
      );
    },
    async save(userID: string, workspaceID: string, raw: unknown) {
      const input = sharedSaveInputSchema.parse(raw);
      return withLoadedDocument(
        workspaceID,
        userID,
        input.path,
        { write: true },
        async (loaded) => {
          const payload = prepareDocumentSave(loaded, input.revision);
          const file = await writeDiskDocument(sources, workspaceID, userID, input.path, payload);
          await persist(workspaceID, input.path, markDocumentSaved(loaded, file.version));
          return file;
        },
      );
    },
    async read(userID: string, workspaceID: string, path: string) {
      sharedDocumentPathSchema.parse(path);
      return withLoadedDocument(workspaceID, userID, path, {}, async (loaded) => {
        await persist(workspaceID, path, loaded);
        return formatReadDocumentPayload(path, loaded);
      });
    },
    async edit(actor: CollaborationActor, workspaceID: string, raw: unknown) {
      const input = sharedEditInputSchema.parse(raw);
      return withLoadedDocument(
        workspaceID,
        actor.userID,
        input.path,
        { write: true },
        async (loaded) => {
          const updated = applyIndexedDocumentEdits(loaded, input.revision, input.edits);
          await persistAuthorized(workspaceID, actor.userID, input.path, updated, true);
          await room.touchAgentEdit(workspaceID, input.path, actor, updated.doc);
          return { path: input.path, revision: documentRevision(updated.doc), dirty: true };
        },
      );
    },
    async resolve(userID: string, workspaceID: string, raw: unknown) {
      const input = sharedResolveInputSchema.parse(raw);
      return locked(workspaceID, input.path, async () => {
        await authorize(workspaceID, userID, true);
        const dedupeKey = `workspace.shared_document_resolution:${input.requestID}`;
        const [previous] = await database.db
          .select({
            actorID: auditEvent.actorId,
            workspaceID: auditEvent.scopeId,
            payload: auditEvent.payload,
          })
          .from(auditEvent)
          .where(eq(auditEvent.dedupeKey, dedupeKey));
        if (previous) {
          if (
            previous.actorID !== userID ||
            previous.workspaceID !== workspaceID ||
            previous.payload["path"] !== input.path ||
            previous.payload["choice"] !== input.choice ||
            previous.payload["documentRevision"] !== input.revision ||
            previous.payload["diskVersion"] !== input.diskVersion
          )
            throw new CommandError(
              "conflict",
              "Resolution identity already records another decision",
            );
          return previous.payload["result"];
        }
        const loaded = await load(workspaceID, userID, input.path);
        try {
          const resolved = resolveDocumentConflict(
            loaded,
            input.revision,
            input.diskVersion,
            input.choice,
          );
          const result = {
            path: input.path,
            revision: documentRevision(resolved.doc),
            dirty: resolved.phase !== "clean",
            conflict: false,
          };
          await persistAuthorized(workspaceID, userID, input.path, resolved, true, async (sql) => {
            await drizzleTransaction(sql)
              .insert(auditEvent)
              .values({
                id: input.requestID,
                kind: "workspace.shared_document_resolution",
                scopeType: "workspace",
                scopeId: workspaceID,
                dedupeKey,
                actorId: userID,
                payload: {
                  path: input.path,
                  choice: input.choice,
                  documentRevision: input.revision,
                  diskVersion: input.diskVersion,
                  result,
                },
              });
          });
          return result;
        } finally {
          loaded.doc.destroy();
        }
      });
    },
    participants: (workspaceID: string, userID: string, path?: string) =>
      room.participants(workspaceID, userID, path),
    revoke: (workspaceID: string, userID: string) => room.revoke(workspaceID, userID),
    async assertSaved(workspaceID: string) {
      const [dirty] = await database.db
        .select({ path: workspaceSharedDocument.path })
        .from(workspaceSharedDocument)
        .where(
          and(
            eq(workspaceSharedDocument.workspaceId, workspaceID),
            ne(workspaceSharedDocument.syncState, "clean"),
          ),
        )
        .limit(1);
      if (dirty)
        throw new CommandError(
          "conflict",
          "Save or resolve shared documents before submitting the saved checkout.",
        );
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      room.clear();
    },
  };
}
