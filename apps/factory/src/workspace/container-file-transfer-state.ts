import { z } from "zod";
import { CommandError } from "../command-error";

export const CHUNK_BYTES = 256 << 10;
export const FILE_OP_KIND = "workspace.file_op";
export const FILE_TRANSFER_KIND = "workspace.file_transfer";

export const nativeFileSchema = z.object({
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

export type NativeFileResult = z.infer<typeof nativeFileSchema>;

export type TransferPhase =
  | "preparing"
  | "active"
  | "committing"
  | "committed"
  | "releasing"
  | "released"
  | "uncertain";

export type TransferRecord = {
  id: string;
  workspaceID: string;
  attemptID: string;
  actorID: string;
  direction: "upload" | "download";
  digest: string;
  path: string;
  state: TransferPhase;
  result: unknown;
  expiresAt: Date;
};

export type ClassifiedTransfer =
  | { kind: "expired-or-released"; row: TransferRecord }
  | { kind: "preparing"; row: TransferRecord }
  | { kind: "active"; row: TransferRecord }
  | { kind: "committing"; row: TransferRecord }
  | { kind: "committed"; row: TransferRecord }
  | { kind: "uncertain"; row: TransferRecord };

export function parseTransferPhase(state: string): TransferPhase {
  switch (state) {
    case "preparing":
    case "active":
    case "committing":
    case "committed":
    case "releasing":
    case "released":
    case "uncertain":
      return state;
    default:
      return "uncertain";
  }
}

export function classifyTransfer(row: TransferRecord, now = Date.now()): ClassifiedTransfer {
  if (row.expiresAt.getTime() <= now || row.state === "released" || row.state === "releasing")
    return { kind: "expired-or-released", row };
  return { kind: row.state, row };
}

export function assertTransferUsable(row: TransferRecord, now = Date.now()) {
  if (classifyTransfer(row, now).kind === "expired-or-released")
    throw new CommandError(
      "conflict",
      "File transfer expired or was released. Its identity cannot be reused.",
    );
}

export function canPollTransferStatus(row: TransferRecord, now = Date.now()) {
  return row.state !== "released" && row.expiresAt.getTime() > now;
}

export function assertUploadChunkAllowed(row: TransferRecord) {
  if (row.direction !== "upload" || row.state !== "active")
    throw new CommandError("conflict", "Upload is not active. Observe its existing transfer ID.");
}

export function assertDownloadChunkAllowed(row: TransferRecord) {
  if (row.direction !== "download" || row.state !== "active")
    throw new CommandError("conflict", "Download is not active");
}

export function assertUploadCommitAllowed(row: TransferRecord): "already-committed" | "commit" {
  if (row.direction !== "upload") throw new CommandError("conflict", "Only uploads commit");
  return row.state === "committed" ? "already-committed" : "commit";
}

export function validateTransferObservation(row: TransferRecord, result: NativeFileResult) {
  if (result.id !== row.id || result.path !== row.path)
    throw new CommandError(
      "unavailable",
      "Native transfer identity differs from its retained intent",
    );
  const { content: _content, ...compact } = result;
  return { compact, committed: row.direction === "upload" && result.complete };
}

export function validateDownloadChunkResult(
  row: TransferRecord,
  offset: number,
  limit: number,
  result: NativeFileResult,
) {
  const retained = nativeFileSchema.parse(row.result);
  const content = Buffer.from(result.content, "base64");
  if (
    result.id !== row.id ||
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
}

export function formatTransferView(row: TransferRecord, now = Date.now()) {
  const result = row.result ? nativeFileSchema.parse(row.result) : undefined;
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
    chunkBytes: CHUNK_BYTES,
    expired: row.expiresAt.getTime() <= now,
  };
}
