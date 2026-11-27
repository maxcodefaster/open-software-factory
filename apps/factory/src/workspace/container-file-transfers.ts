import { and, eq, ne, notInArray, sql as query } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import { type WorkspaceTransferInput, workspaceTransferInput } from "#workspace-domain/files";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import {
  assertDownloadChunkAllowed,
  assertTransferUsable,
  assertUploadChunkAllowed,
  assertUploadCommitAllowed,
  CHUNK_BYTES,
  canPollTransferStatus,
  FILE_TRANSFER_KIND,
  formatTransferView,
  type NativeFileResult,
  nativeFileSchema,
  parseTransferPhase,
  type TransferRecord,
  validateDownloadChunkResult,
  validateTransferObservation,
} from "./container-file-transfer-state";

type TransferDeps = {
  database: ReturnType<typeof createDatabase>;
  hub: RuntimeHub;
  isClosing(): boolean;
  digest(value: unknown): string;
  authorize(userID: string, workspaceID: string, write?: boolean): Promise<void>;
  ready(workspaceID: string, userID: string, write?: boolean, attemptID?: string): Promise<string>;
  call(
    userID: string,
    workspaceID: string,
    attemptID: string,
    action: string,
    data: unknown,
    write: boolean,
  ): Promise<unknown>;
};

export function createContainerFileTransfers(deps: TransferDeps) {
  const { database, hub, digest, authorize, ready, call } = deps;
  const transferRowWhere = (id: string) =>
    and(eq(operation.id, id), eq(operation.kind, FILE_TRANSFER_KIND));
  const markUncertain = (
    id: string,
    condition: ReturnType<typeof eq> | ReturnType<typeof notInArray>,
  ) =>
    database.db
      .update(operation)
      .set({ state: "uncertain", updatedAt: query`now()` })
      .where(and(transferRowWhere(id), condition));

  async function loadTransfer(userID: string, id: string, active = true): Promise<TransferRecord> {
    const [row] = await database.db
      .select({
        id: operation.id,
        workspaceID: operation.scopeId,
        attemptID: query<string>`${operation.payload}->>'runtimeAttemptId'`,
        actorID: operation.createdBy,
        direction: query<"upload" | "download">`${operation.payload}->>'direction'`,
        digest: query<string>`${operation.payload}->>'inputDigest'`,
        path: query<string>`${operation.payload}->>'path'`,
        state: operation.state,
        result: operation.result,
        expiresAt: operation.leaseExpiresAt,
      })
      .from(operation)
      .where(and(transferRowWhere(z.uuid().parse(id)), eq(operation.createdBy, userID)));
    if (!row?.actorID) throw new CommandError("not-found", "File transfer not found");
    const record: TransferRecord = {
      ...row,
      actorID: row.actorID,
      state: parseTransferPhase(row.state),
      expiresAt: z.coerce.date().parse(row.expiresAt),
    };
    await authorize(userID, record.workspaceID, record.direction === "upload");
    if (active) assertTransferUsable(record);
    return record;
  }

  async function readyTransfer(userID: string, row: TransferRecord) {
    const attemptID = await ready(
      row.workspaceID,
      userID,
      row.direction === "upload",
      row.attemptID,
    );
    if (attemptID !== row.attemptID)
      throw new CommandError(
        "conflict",
        "Transfer belongs to a different Runtime Attempt. It cannot be recreated.",
      );
  }

  async function observe(row: TransferRecord, result: NativeFileResult) {
    const { compact, committed } = validateTransferObservation(row, result);
    await database.db
      .update(operation)
      .set({
        result: compact,
        state: query`CASE WHEN ${operation.state} IN ('committed','releasing','released')
          THEN ${operation.state} WHEN ${committed} THEN 'committed'
          WHEN ${operation.payload}->>'commitAttemptedAt' IS NOT NULL THEN ${operation.state} ELSE 'active' END`,
        completedAt: query`CASE WHEN ${operation.completedAt} IS NOT NULL THEN ${operation.completedAt}
          WHEN ${committed} THEN now() ELSE NULL END`,
        updatedAt: query`now()`,
      })
      .where(transferRowWhere(row.id));
  }

  async function status(userID: string, id: string) {
    const row = await loadTransfer(userID, id, false);
    if (canPollTransferStatus(row) && hub.connected(row.attemptID)) {
      try {
        await observe(
          row,
          nativeFileSchema.parse(
            await call(
              userID,
              row.workspaceID,
              row.attemptID,
              "file-transfer-status",
              { id },
              false,
            ),
          ),
        );
      } catch {
        await authorize(userID, row.workspaceID);
        await markUncertain(
          id,
          notInArray(operation.state, ["committed", "releasing", "released"]),
        );
      }
    }
    return formatTransferView(await loadTransfer(userID, id, false));
  }

  async function begin(userID: string, value: WorkspaceTransferInput) {
    const input = workspaceTransferInput.parse(value);
    await authorize(userID, input.workspaceID, input.direction === "upload");
    const fingerprint = digest(input);
    const idempotencyKey = `${FILE_TRANSFER_KIND}:${input.requestID}`;
    const [existing] = await database.db
      .select({
        digest: query<string>`${operation.payload}->>'inputDigest'`,
        actorID: operation.createdBy,
      })
      .from(operation)
      .where(eq(operation.idempotencyKey, idempotencyKey));
    if (existing) {
      if (existing.digest !== fingerprint || existing.actorID !== userID)
        throw new CommandError(
          "conflict",
          "File transfer identity already records different input",
        );
      return status(userID, input.requestID);
    }
    const attemptID = await ready(input.workspaceID, userID, input.direction === "upload");
    const created = await database.client.begin(async (sql) => {
      if (input.direction === "upload")
        await workspaceWriteAuthorityIn(sql, input.workspaceID, userID);
      else await workspaceAuthorityIn(sql, input.workspaceID, userID, true);
      const [row] = await drizzleTransaction(sql)
        .insert(operation)
        .values({
          id: input.requestID,
          kind: FILE_TRANSFER_KIND,
          scopeType: "workspace",
          scopeId: input.workspaceID,
          idempotencyKey,
          state: "preparing",
          createdBy: userID,
          leaseExpiresAt: query`now() + interval '30 minutes'`,
          payload: {
            runtimeAttemptId: attemptID,
            direction: input.direction,
            inputDigest: fingerprint,
            path: input.path,
          },
        })
        .onConflictDoNothing()
        .returning({ id: operation.id });
      return Boolean(row);
    });
    if (!created) return begin(userID, input);
    const row = await loadTransfer(userID, input.requestID);
    try {
      await observe(
        row,
        nativeFileSchema.parse(
          await call(
            userID,
            input.workspaceID,
            attemptID,
            `file-${input.direction}-begin`,
            {
              id: input.requestID,
              path: input.path,
              ...(input.version ? { version: input.version } : {}),
              ...(input.direction === "upload" ? { bytes: input.bytes, sha256: input.sha256 } : {}),
            },
            input.direction === "upload",
          ),
        ),
      );
    } catch (cause) {
      await markUncertain(row.id, eq(operation.state, "preparing"));
      throw cause;
    }
    return formatTransferView(await loadTransfer(userID, row.id));
  }

  async function upload(userID: string, id: string, offset: number, content: Uint8Array) {
    z.number()
      .int()
      .nonnegative()
      .max(128 << 20)
      .parse(offset);
    if (content.byteLength > CHUNK_BYTES)
      throw new CommandError("invalid", "Upload chunk exceeds 256 KiB");
    const row = await loadTransfer(userID, id);
    assertUploadChunkAllowed(row);
    await readyTransfer(userID, row);
    // Row locking orders concurrent chunks before commit, without creating a second native upload.
    await database.client.begin(async (sql) => {
      await workspaceWriteAuthorityIn(sql, row.workspaceID, userID);
      const db = drizzleTransaction(sql);
      const [current] = await db
        .select({ state: operation.state })
        .from(operation)
        .where(transferRowWhere(id))
        .for("update");
      if (current?.state !== "active") throw new CommandError("conflict", "Upload state changed");
      const response = await hub.childRequest(
        row.attemptID,
        {
          operationId: crypto.randomUUID(),
          action: "file-upload-chunk",
          data: JSON.stringify({
            id,
            offset,
            content: Buffer.from(content).toString("base64"),
          }),
        },
        async (send) => {
          if (deps.isClosing()) throw new CommandError("unavailable", "Factory is stopping");
          send();
        },
      );
      if (!response) throw new CommandError("unavailable", "Upload chunk outcome is unconfirmed");
      const result = nativeFileSchema.parse(JSON.parse(response));
      const { content: _content, ...compact } = result;
      if (result.id !== id || result.path !== row.path)
        throw new CommandError("unavailable", "Native upload identity changed");
      await db
        .update(operation)
        .set({ result: compact, updatedAt: query`now()` })
        .where(transferRowWhere(id));
    });
    return formatTransferView(await loadTransfer(userID, id));
  }

  async function download(userID: string, id: string, offset: number, limit = CHUNK_BYTES) {
    z.number()
      .int()
      .nonnegative()
      .max(128 << 20)
      .parse(offset);
    z.number().int().positive().max(CHUNK_BYTES).parse(limit);
    const row = await loadTransfer(userID, id);
    assertDownloadChunkAllowed(row);
    await readyTransfer(userID, row);
    const result = nativeFileSchema.parse(
      await call(
        userID,
        row.workspaceID,
        row.attemptID,
        "file-download-chunk",
        { id, offset, limit },
        false,
      ),
    );
    return validateDownloadChunkResult(row, offset, limit, result);
  }

  async function commit(userID: string, id: string) {
    const row = await loadTransfer(userID, id);
    if (assertUploadCommitAllowed(row) === "already-committed") return formatTransferView(row);
    await readyTransfer(userID, row);
    const [claimed] = await database.db
      .update(operation)
      .set({
        state: "committing",
        payload: query`${operation.payload} || jsonb_build_object('commitAttemptedAt', now())`,
        updatedAt: query`now()`,
      })
      .where(
        and(
          transferRowWhere(id),
          eq(operation.state, "active"),
          query`${operation.payload}->>'commitAttemptedAt' IS NULL`,
        ),
      )
      .returning({ id: operation.id });
    if (!claimed) return status(userID, id);
    try {
      await observe(
        row,
        nativeFileSchema.parse(
          await call(userID, row.workspaceID, row.attemptID, "file-upload-commit", { id }, true),
        ),
      );
    } catch (cause) {
      await markUncertain(id, eq(operation.state, "committing"));
      throw cause;
    }
    return formatTransferView(await loadTransfer(userID, id));
  }

  async function release(userID: string, id: string) {
    const row = await loadTransfer(userID, id, false);
    if (row.state === "released") return formatTransferView(row);
    await database.db
      .update(operation)
      .set({ state: "releasing", updatedAt: query`now()` })
      .where(and(transferRowWhere(id), ne(operation.state, "released")));
    await call(
      userID,
      row.workspaceID,
      row.attemptID,
      "file-release",
      { id },
      row.direction === "upload",
    );
    await database.db
      .update(operation)
      .set({
        state: "released",
        completedAt: query`COALESCE(${operation.completedAt}, now())`,
        updatedAt: query`now()`,
      })
      .where(transferRowWhere(id));
    return formatTransferView(await loadTransfer(userID, id, false));
  }

  return { begin, status, upload, download, commit, release };
}
