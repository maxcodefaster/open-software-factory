import { and, eq, sql as expression, type SQL } from "drizzle-orm";
import { z } from "zod";
import { attachmentLimits, attachmentSummary } from "#conversation-domain/attachments";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { attachment, attachmentReference, operation } from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import type { ConvertedAttachment } from "./conversion-result";
import { type AttachmentObjects, attachmentDigest } from "./objects";

export type AttachmentDatabase = ReturnType<typeof createDatabase>;
export type AttachmentDrizzle = ReturnType<typeof drizzleTransaction>;
export type StoredAttachmentObject = (typeof attachment.$inferSelect)["objects"][number];
export type AttachmentConverter = (
  data: Uint8Array,
  mediaType: string,
) => Promise<ConvertedAttachment>;

export const ATTACHMENT_DRAFT_KIND = "attachments.draft";
export const ATTACHMENT_DRAFT_SCOPE_TYPE = "attachment";
export const attachmentDraftIdempotencyKey = (draftID: string, userID: string) =>
  `${ATTACHMENT_DRAFT_KIND}:${draftID}:${userID}`;

export const ATTACHMENT_STORAGE_KIND = "attachment.storage";
export const ATTACHMENT_STORAGE_IDEMPOTENCY_KEY = "attachment.storage:singleton";

export const ATTACHMENT_TURN_CONTEXT_KIND = "attachment.turn_context";
export const ATTACHMENT_TURN_CONTEXT_SCOPE_TYPE = "agent_turn";
export const attachmentTurnContextIdempotencyKey = (turnID: string, source: string) =>
  `${ATTACHMENT_TURN_CONTEXT_KIND}:${turnID}:${source}`;

export const attachmentFields = {
  id: attachment.id,
  projectId: attachment.projectId,
  ownerId: attachment.ownerId,
  draftId: attachment.draftId,
  name: attachment.name,
  mediaType: attachment.mediaType,
  bytes: attachment.byteLength,
  sha256: attachment.sha256,
  state: attachment.state,
  failure: attachment.failure,
  text: attachment.textContent,
  objects: attachment.objects,
};

export type AttachmentRow = Awaited<ReturnType<typeof readableAttachmentIn>>;
export type AttachmentLimits = ReturnType<typeof configuredAttachmentLimits>;

export function configuredAttachmentLimits() {
  const value = (name: keyof typeof attachmentLimits) => {
    const environment = `FACTORY_ATTACHMENT_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
    const configured = process.env[environment];
    const bytes = configured === undefined ? attachmentLimits[name] : Number(configured);
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error(`${environment} must be a positive safe integer number of bytes`);
    return bytes;
  };
  return {
    fileBytes: value("fileBytes"),
    messageBytes: value("messageBytes"),
  };
}

export function attachmentSummaryFromRow(row: AttachmentRow) {
  return attachmentSummary.parse({
    id: row.id,
    name: row.name,
    mediaType: row.mediaType,
    bytes: row.bytes,
    sha256: row.sha256,
    state: row.state,
    failure: row.failure,
    pages: Math.max(0, row.objects.length - 1),
  });
}

export async function readableAttachmentIn(
  sql: DatabaseTransaction,
  userID: string,
  id: string,
  write = false,
) {
  const db = drizzleTransaction(sql);
  const [scope] = await db
    .select({ projectId: attachment.projectId })
    .from(attachment)
    .where(eq(attachment.id, z.uuid().parse(id)));
  if (!scope) throw new CommandError("not-found", "Attachment not found");
  // Match admission/revocation lock ordering. Readers must not hold an asset
  // share lock while waiting behind an account revocation.
  await projectAuthorityIn(sql, userID, scope.projectId);
  const [row] = await db
    .select(attachmentFields)
    .from(attachment)
    .where(eq(attachment.id, id))
    .for(write ? "update" : "share");
  if (!row || row.state === "deleted" || row.state === "deleting")
    throw new CommandError("not-found", "Attachment not found");
  const [shared] = await db
    .select({ attachmentId: attachmentReference.attachmentId })
    .from(attachmentReference)
    .where(and(eq(attachmentReference.attachmentId, id), eq(attachmentReference.shared, true)))
    .limit(1);
  if (row.ownerId !== userID && !shared)
    throw new CommandError("not-found", "Attachment not found");
  return row;
}

export async function requireReadyProjectAttachmentIn(
  sql: DatabaseTransaction,
  userID: string,
  projectID: string,
  id: string,
  code: "conflict" | "not-found",
  message: string,
) {
  const asset = await readableAttachmentIn(sql, userID, id);
  if (asset.projectId !== projectID || asset.state !== "ready")
    throw new CommandError(code, message);
  return asset;
}

export function turnContextWhere(scopeId: string | SQL<string>) {
  return and(
    eq(operation.kind, ATTACHMENT_TURN_CONTEXT_KIND),
    eq(operation.scopeType, ATTACHMENT_TURN_CONTEXT_SCOPE_TYPE),
    eq(operation.scopeId, scopeId),
  );
}

export const turnContextSourceExpr = () => expression<string>`${operation.payload}->>'source'`;
export const turnContextContentExpr = () => expression<string>`${operation.payload}->>'content'`;

export async function insertTurnReferenceIn(
  db: AttachmentDrizzle,
  attachmentId: string,
  turnId: string,
  shared: boolean,
) {
  await db
    .insert(attachmentReference)
    .values({ attachmentId, kind: "turn", referenceId: turnId, shared })
    .onConflictDoNothing();
}

export async function recordTurnContextIn(
  db: AttachmentDrizzle,
  turnId: string,
  source: "admission" | "feedback",
  content: string,
  createdBy: string,
  ignoreConflict: boolean,
) {
  const query = db.insert(operation).values({
    id: crypto.randomUUID(),
    kind: ATTACHMENT_TURN_CONTEXT_KIND,
    scopeType: ATTACHMENT_TURN_CONTEXT_SCOPE_TYPE,
    scopeId: turnId,
    idempotencyKey: attachmentTurnContextIdempotencyKey(turnId, source),
    state: "recorded",
    payload: { turnId, source, content },
    createdBy,
  });
  await (ignoreConflict ? query.onConflictDoNothing({ target: operation.idempotencyKey }) : query);
}

export function draftOperationMatchesAttachment(attachmentMatcher: SQL, projectMatcher?: SQL) {
  return and(
    eq(operation.kind, ATTACHMENT_DRAFT_KIND),
    eq(operation.scopeType, ATTACHMENT_DRAFT_SCOPE_TYPE),
    eq(operation.state, "draft"),
    projectMatcher,
    attachmentMatcher,
  );
}

export async function readVerifiedAttachmentBytes(
  objects: AttachmentObjects,
  object: StoredAttachmentObject,
) {
  const bytes = await objects.read(object.key);
  if (bytes.byteLength !== object.bytes || attachmentDigest(bytes) !== object.sha256)
    throw new CommandError("unavailable", "Stored attachment content could not be verified.");
  return bytes;
}
