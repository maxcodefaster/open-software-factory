import { createHmac } from "node:crypto";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  containerFileMutation,
  containerFilePath,
  workspaceTransferInput,
  type ContainerFileMutation,
  type WorkspaceTransferInput,
} from "../../../../packages/workspace-domain/src/files";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { createRuntimeController } from "../runtime/controller";
import type { RuntimeHub } from "../runtime/hub";
import { createWorkspaceComputeAccess } from "./compute-access";

const nativeFile = z.object({
  id: z.uuid().optional(),
  path: z.string().optional(),
  version: z.string().optional(),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 << 20),
  directory: z.boolean().default(false),
  content: z.string().max(350_000).default(""),
  offset: z.number().int().nonnegative().default(0),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .max(128 << 20)
    .default(0),
  complete: z.boolean().default(false),
});
type Transfer = {
  id: string;
  workspaceID: string;
  attemptID: string;
  actorID: string;
  direction: "upload" | "download";
  digest: string;
  path: string;
  state: string;
  result: unknown;
  expiresAt: Date;
};
const chunkBytes = 256 << 10;

export function createWorkspaceContainerFiles(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  runtime: Pick<ReturnType<typeof createRuntimeController>, "start" | "startPersisted" | "get">,
  signingKey: string,
) {
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  const ready = createWorkspaceComputeAccess(database, hub, runtime, () => closing);
  const digest = (value: unknown) =>
    createHmac("sha256", signingKey).update(JSON.stringify(value)).digest("hex");
  async function track<T>(operation: () => Promise<T>) {
    if (closing) throw new CommandError("unavailable", "Factory is stopping");
    const promise = operation();
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
  async function transfer(userID: string, id: string, active = true) {
    const [row] = await database.client<
      Transfer[]
    >`SELECT id,workspace_id AS "workspaceID",runtime_attempt_id AS "attemptID",
      actor_id AS "actorID",direction,input_digest AS digest,path,state,result,expires_at AS "expiresAt"
      FROM factory.workspace_file_transfer WHERE id=${z.uuid().parse(id)} AND actor_id=${userID}`;
    if (!row) throw new CommandError("not-found", "File transfer not found");
    row.expiresAt = z.coerce.date().parse(row.expiresAt);
    await authorize(userID, row.workspaceID, row.direction === "upload");
    if (
      active &&
      (row.expiresAt.getTime() <= Date.now() || ["released", "releasing"].includes(row.state))
    )
      throw new CommandError(
        "conflict",
        "File transfer expired or was released. Its identity cannot be reused.",
      );
    return row;
  }
  function view(row: Transfer) {
    const result = row.result ? nativeFile.parse(row.result) : undefined;
    return {
      transferID: row.id,
      workspaceID: row.workspaceID,
      attemptID: row.attemptID,
      direction: row.direction,
      path: row.path,
      state: row.state,
      expiresAt: row.expiresAt.toISOString(),
      bytes: result?.bytes ?? null,
      sha256: result?.version ?? null,
      nextOffset: result?.nextOffset ?? 0,
      chunkBytes,
      expired: row.expiresAt.getTime() <= Date.now(),
    };
  }
  async function readyTransfer(userID: string, row: Transfer) {
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
  async function observe(row: Transfer, result: z.infer<typeof nativeFile>) {
    if (result.id !== row.id || result.path !== row.path)
      throw new CommandError(
        "unavailable",
        "Native transfer identity differs from its retained intent",
      );
    const { content: _content, ...compact } = result;
    await database.client`UPDATE factory.workspace_file_transfer SET result=${JSON.stringify(compact)}::text::jsonb,
      state=CASE WHEN state IN ('committed','releasing','released') THEN state WHEN ${row.direction === "upload" && result.complete} THEN 'committed'
        WHEN commit_attempted_at IS NOT NULL THEN state ELSE 'active' END,
      updated_at=now() WHERE id=${row.id}`;
  }
  async function status(userID: string, id: string) {
    const row = await transfer(userID, id, false);
    if (
      row.state !== "released" &&
      row.expiresAt.getTime() > Date.now() &&
      hub.connected(row.attemptID)
    ) {
      try {
        await observe(
          row,
          nativeFile.parse(
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
        await database.client`UPDATE factory.workspace_file_transfer SET state='uncertain',updated_at=now()
          WHERE id=${id} AND state NOT IN ('committed','releasing','released')`;
      }
    }
    return view(await transfer(userID, id, false));
  }
  async function begin(userID: string, value: WorkspaceTransferInput) {
    const input = workspaceTransferInput.parse(value);
    await authorize(userID, input.workspaceID, input.direction === "upload");
    const fingerprint = digest(input);
    const [existing] = await database.client<
      { digest: string; actorID: string }[]
    >`SELECT input_digest AS digest,actor_id AS "actorID"
      FROM factory.workspace_file_transfer WHERE id=${input.requestID}`;
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
      const [row] =
        await sql`INSERT INTO factory.workspace_file_transfer(id,workspace_id,runtime_attempt_id,actor_id,direction,input_digest,path,state)
        VALUES(${input.requestID},${input.workspaceID},${attemptID},${userID},${input.direction},${fingerprint},${input.path},'preparing')
        ON CONFLICT(id) DO NOTHING RETURNING id`;
      return Boolean(row);
    });
    if (!created) return begin(userID, input);
    const row = await transfer(userID, input.requestID);
    try {
      await observe(
        row,
        nativeFile.parse(
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
      await database.client`UPDATE factory.workspace_file_transfer SET state='uncertain',updated_at=now() WHERE id=${row.id} AND state='preparing'`;
      throw cause;
    }
    return view(await transfer(userID, row.id));
  }
  return {
    begin: (userID: string, input: WorkspaceTransferInput) => track(() => begin(userID, input)),
    status: (userID: string, id: string) => track(() => status(userID, id)),
    context: (userID: string, workspaceID: string) =>
      track(async () => {
        const attemptID = await ready(z.uuid().parse(workspaceID), userID, false);
        return z
          .object({ workspaceFolder: z.string(), userID: z.number().int() })
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
        const result = nativeFile.parse(
          await call(userID, parsed.workspaceID, attemptID, "file-read", parsed, false),
        );
        return {
          path: result.path,
          bytes: result.bytes,
          version: result.version,
          content: Buffer.from(result.content, "base64").toString("utf8"),
          nextOffset: result.complete ? null : result.nextOffset,
        };
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
          .object({ entries: z.array(nativeFile), nextOffset: z.number().int().nullable() })
          .parse(await call(userID, parsed.workspaceID, attemptID, "file-list", parsed, false));
      }),
    mutate: (userID: string, value: ContainerFileMutation) =>
      track(async () => {
        const input = containerFileMutation.parse(value);
        await authorize(userID, input.workspaceID, true);
        const fingerprint = digest(input);
        const [existing] = await database.client<
          { digest: string; actorID: string; result: unknown }[]
        >`SELECT input_digest AS digest,actor_id AS "actorID",result
        FROM factory.workspace_file_operation WHERE id=${input.requestID}`;
        if (existing) {
          if (existing.digest !== fingerprint || existing.actorID !== userID)
            throw new CommandError(
              "conflict",
              "File operation identity already records different input",
            );
          return existing.result ?? { requestID: input.requestID, state: "uncertain" };
        }
        const attemptID = await ready(input.workspaceID, userID);
        const [created] =
          await database.client`INSERT INTO factory.workspace_file_operation(id,workspace_id,runtime_attempt_id,actor_id,action,input_digest)
        VALUES(${input.requestID},${input.workspaceID},${attemptID},${userID},${input.action},${fingerprint}) ON CONFLICT(id) DO NOTHING RETURNING id`;
        if (!created)
          throw new CommandError(
            "conflict",
            "File operation already admitted. Observe it using the same request identity.",
          );
        const result = nativeFile.parse(
          await call(userID, input.workspaceID, attemptID, `file-${input.action}`, input, true),
        );
        await database.client`UPDATE factory.workspace_file_operation SET result=${JSON.stringify(result)}::text::jsonb,completed_at=now() WHERE id=${input.requestID}`;
        return result;
      }),
    upload: (userID: string, id: string, offset: number, content: Uint8Array) =>
      track(async () => {
        z.number()
          .int()
          .nonnegative()
          .max(128 << 20)
          .parse(offset);
        if (content.byteLength > chunkBytes)
          throw new CommandError("invalid", "Upload chunk exceeds 256 KiB");
        const row = await transfer(userID, id);
        if (row.direction !== "upload" || row.state !== "active")
          throw new CommandError(
            "conflict",
            "Upload is not active. Observe its existing transfer ID.",
          );
        await readyTransfer(userID, row);
        // Row locking orders concurrent chunks before commit, without creating a second native upload.
        await database.client.begin(async (sql) => {
          await workspaceWriteAuthorityIn(sql, row.workspaceID, userID);
          const [current] = await sql<
            { state: string }[]
          >`SELECT state FROM factory.workspace_file_transfer WHERE id=${id} FOR UPDATE`;
          if (current?.state !== "active")
            throw new CommandError("conflict", "Upload state changed");
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
              if (closing) throw new CommandError("unavailable", "Factory is stopping");
              send();
            },
          );
          if (!response)
            throw new CommandError("unavailable", "Upload chunk outcome is unconfirmed");
          const result = nativeFile.parse(JSON.parse(response));
          const { content: _content, ...compact } = result;
          if (result.id !== id || result.path !== row.path)
            throw new CommandError("unavailable", "Native upload identity changed");
          await sql`UPDATE factory.workspace_file_transfer SET result=${JSON.stringify(compact)}::text::jsonb,updated_at=now() WHERE id=${id}`;
        });
        return view(await transfer(userID, id));
      }),
    download: (userID: string, id: string, offset: number, limit = chunkBytes) =>
      track(async () => {
        z.number()
          .int()
          .nonnegative()
          .max(128 << 20)
          .parse(offset);
        z.number().int().positive().max(chunkBytes).parse(limit);
        const row = await transfer(userID, id);
        if (row.direction !== "download" || row.state !== "active")
          throw new CommandError("conflict", "Download is not active");
        await readyTransfer(userID, row);
        const result = nativeFile.parse(
          await call(
            userID,
            row.workspaceID,
            row.attemptID,
            "file-download-chunk",
            { id, offset, limit },
            false,
          ),
        );
        const retained = nativeFile.parse(row.result);
        const content = Buffer.from(result.content, "base64");
        if (
          result.id !== id ||
          result.path !== row.path ||
          result.version !== retained.version ||
          result.bytes !== retained.bytes ||
          result.offset !== offset ||
          result.nextOffset !== offset + content.length ||
          content.length > limit
        )
          throw new CommandError("unavailable", "Download bytes do not match the pinned transfer");
        return {
          content,
          offset,
          nextOffset: result.nextOffset,
          complete: result.complete,
          bytes: result.bytes,
          sha256: result.version,
        };
      }),
    commit: (userID: string, id: string) =>
      track(async () => {
        const row = await transfer(userID, id);
        if (row.direction !== "upload") throw new CommandError("conflict", "Only uploads commit");
        if (row.state === "committed") return view(row);
        await readyTransfer(userID, row);
        const [claimed] =
          await database.client`UPDATE factory.workspace_file_transfer SET state='committing',commit_attempted_at=now(),updated_at=now()
        WHERE id=${id} AND state='active' AND commit_attempted_at IS NULL RETURNING id`;
        if (!claimed) return status(userID, id);
        try {
          await observe(
            row,
            nativeFile.parse(
              await call(
                userID,
                row.workspaceID,
                row.attemptID,
                "file-upload-commit",
                { id },
                true,
              ),
            ),
          );
        } catch (cause) {
          await database.client`UPDATE factory.workspace_file_transfer SET state='uncertain',updated_at=now() WHERE id=${id} AND state='committing'`;
          throw cause;
        }
        return view(await transfer(userID, id));
      }),
    release: (userID: string, id: string) =>
      track(async () => {
        const row = await transfer(userID, id, false);
        if (row.state === "released") return view(row);
        await database.client`UPDATE factory.workspace_file_transfer SET state='releasing',updated_at=now() WHERE id=${id} AND state<>'released'`;
        await call(
          userID,
          row.workspaceID,
          row.attemptID,
          "file-release",
          { id },
          row.direction === "upload",
        );
        await database.client`UPDATE factory.workspace_file_transfer SET state='released',updated_at=now() WHERE id=${id}`;
        return view(await transfer(userID, id, false));
      }),
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
    },
  };
}
