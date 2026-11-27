import { createHmac } from "node:crypto";
import { and, eq, sql as query } from "drizzle-orm";
import { z } from "zod";
import type { createDatabase } from "#db/client";
import { operation } from "#db/schema";
import {
  type ContainerFileMutation,
  containerFileMutation,
  containerFilePath,
  type WorkspaceTransferInput,
} from "#workspace-domain/files";
import { decodeUTF8Text, UTF8TextPageError } from "#workspace-domain/text-page";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { createRuntimeController } from "../runtime/api";
import type { RuntimeHub } from "../runtime/transport-api";
import { createWorkspaceComputeAccess } from "./compute-access";
import { CHUNK_BYTES, FILE_OP_KIND, nativeFileSchema } from "./container-file-transfer-state";
import { createContainerFileTransfers } from "./container-file-transfers";

export function createWorkspaceContainerFiles(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  runtime: Pick<
    ReturnType<typeof createRuntimeController>,
    "start" | "startPersisted" | "resumeForSource" | "get"
  >,
  signingKey: string,
) {
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  const ready = createWorkspaceComputeAccess(database, hub, runtime, () => closing);
  const digest = (value: unknown) =>
    createHmac("sha256", signingKey).update(JSON.stringify(value)).digest("hex");

  async function track<T>(run: () => Promise<T>) {
    if (closing) throw new CommandError("unavailable", "Factory is stopping");
    const promise = run();
    pending.add(promise);
    try {
      return await promise;
    } finally {
      pending.delete(promise);
    }
  }

  const authorize = (userID: string, workspaceID: string, write = false) =>
    database.client.begin(async (sql) => {
      if (write) await workspaceWriteAuthorityIn(sql, workspaceID, userID);
      else await workspaceAuthorityIn(sql, workspaceID, userID, true);
    });

  async function call(
    userID: string,
    workspaceID: string,
    attemptID: string,
    action: string,
    data: unknown,
    write: boolean,
  ) {
    const response = await hub.childRequest(
      attemptID,
      { operationId: crypto.randomUUID(), action, data: JSON.stringify(data) },
      async (send) => {
        await database.client.begin(async (sql) => {
          if (closing) throw new CommandError("unavailable", "Factory is stopping");
          if (write) await workspaceWriteAuthorityIn(sql, workspaceID, userID);
          else await workspaceAuthorityIn(sql, workspaceID, userID, true);
          send();
        });
      },
    );
    if (!response) throw new CommandError("unavailable", "Container file outcome is unconfirmed");
    await authorize(userID, workspaceID);
    return JSON.parse(response) as unknown;
  }

  const transfers = createContainerFileTransfers({
    database,
    hub,
    isClosing: () => closing,
    digest,
    authorize,
    ready,
    call,
  });

  return {
    begin: (userID: string, input: WorkspaceTransferInput) =>
      track(() => transfers.begin(userID, input)),
    status: (userID: string, id: string) => track(() => transfers.status(userID, id)),
    context: (userID: string, workspaceID: string) =>
      track(async () => {
        const attemptID = await ready(z.uuid().parse(workspaceID), userID, false);
        return z
          .object({
            workspaceFolder: z.string(),
            checkoutFolder: z.string().optional(),
            userID: z.number().int(),
          })
          .parse(await call(userID, workspaceID, attemptID, "file-context", {}, false));
      }),
    read: (
      userID: string,
      input: {
        workspaceID: string;
        path: string;
        offset?: number;
        limit?: number;
        version?: string;
      },
    ) =>
      track(async () => {
        const parsed = z
          .object({
            workspaceID: z.uuid(),
            path: containerFilePath,
            offset: z
              .number()
              .int()
              .nonnegative()
              .max(128 << 20)
              .default(0),
            limit: z.number().int().positive().max(16384).default(8192),
            version: z.string().optional(),
          })
          .parse(input);
        const attemptID = await ready(parsed.workspaceID, userID, false);
        try {
          const result = nativeFileSchema.parse(
            await call(userID, parsed.workspaceID, attemptID, "file-read", parsed, false),
          );
          const content = Buffer.from(result.content, "base64");
          if (
            result.path !== parsed.path ||
            !result.version ||
            result.offset !== parsed.offset ||
            content.length > parsed.limit ||
            result.nextOffset !== parsed.offset + content.length ||
            result.nextOffset > result.bytes ||
            result.complete !== (result.nextOffset === result.bytes) ||
            (!result.complete && !content.length)
          )
            throw new CommandError("unavailable", "Container text page has an invalid byte window");
          if (parsed.version && result.version !== parsed.version)
            throw new CommandError("conflict", "File changed between pages");
          return {
            path: result.path,
            bytes: result.bytes,
            version: result.version,
            content: decodeUTF8Text(content),
            nextOffset: result.complete ? null : result.nextOffset,
          };
        } catch (cause) {
          if (
            cause instanceof UTF8TextPageError ||
            (cause instanceof Error && cause.message.startsWith("UTF-8 text page "))
          )
            throw new CommandError("invalid", cause.message);
          if (cause instanceof Error && cause.message === "container file version changed")
            throw new CommandError("conflict", "File changed between pages");
          throw cause;
        }
      }),
    list: (
      userID: string,
      input: { workspaceID: string; path: string; offset?: number; limit?: number },
    ) =>
      track(async () => {
        const parsed = z
          .object({
            workspaceID: z.uuid(),
            path: containerFilePath,
            offset: z.number().int().nonnegative().max(10000).default(0),
            limit: z.number().int().positive().max(100).default(50),
          })
          .parse(input);
        const attemptID = await ready(parsed.workspaceID, userID, false);
        return z
          .object({ entries: z.array(nativeFileSchema), nextOffset: z.number().int().nullable() })
          .parse(await call(userID, parsed.workspaceID, attemptID, "file-list", parsed, false));
      }),
    mutate: (userID: string, value: ContainerFileMutation) =>
      track(async () => {
        const input = containerFileMutation.parse(value);
        await authorize(userID, input.workspaceID, true);
        const fingerprint = digest(input);
        const idempotencyKey = `${FILE_OP_KIND}:${input.requestID}`;
        const [existing] = await database.db
          .select({
            digest: query<string>`${operation.payload}->>'inputDigest'`,
            actorID: operation.createdBy,
            result: operation.result,
          })
          .from(operation)
          .where(eq(operation.idempotencyKey, idempotencyKey));
        if (existing) {
          if (existing.digest !== fingerprint || existing.actorID !== userID)
            throw new CommandError(
              "conflict",
              "File operation identity already records different input",
            );
          return existing.result ?? { requestID: input.requestID, state: "uncertain" };
        }
        const attemptID = await ready(input.workspaceID, userID);
        const [created] = await database.db
          .insert(operation)
          .values({
            id: input.requestID,
            kind: FILE_OP_KIND,
            scopeType: "workspace",
            scopeId: input.workspaceID,
            idempotencyKey,
            state: "pending",
            createdBy: userID,
            payload: {
              runtimeAttemptId: attemptID,
              action: input.action,
              inputDigest: fingerprint,
            },
          })
          .onConflictDoNothing()
          .returning({ id: operation.id });
        if (!created)
          throw new CommandError(
            "conflict",
            "File operation already admitted. Observe it using the same request identity.",
          );
        const result = nativeFileSchema.parse(
          await call(userID, input.workspaceID, attemptID, `file-${input.action}`, input, true),
        );
        await database.db
          .update(operation)
          .set({
            state: "completed",
            result,
            completedAt: query`now()`,
            updatedAt: query`now()`,
          })
          .where(and(eq(operation.id, input.requestID), eq(operation.kind, FILE_OP_KIND)));
        return result;
      }),
    upload: (userID: string, id: string, offset: number, content: Uint8Array) =>
      track(() => transfers.upload(userID, id, offset, content)),
    download: (userID: string, id: string, offset: number, limit = CHUNK_BYTES) =>
      track(() => transfers.download(userID, id, offset, limit)),
    commit: (userID: string, id: string) => track(() => transfers.commit(userID, id)),
    release: (userID: string, id: string) => track(() => transfers.release(userID, id)),
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
    },
  };
}
