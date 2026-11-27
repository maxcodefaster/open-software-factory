import {
  and,
  asc,
  eq,
  exists,
  sql as expression,
  inArray,
  isNull,
  lt,
  ne,
  not,
  or,
} from "drizzle-orm";
import { z } from "zod";
import { attachmentIDs } from "#conversation-domain/attachments";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { attachment, attachmentReference, operation, ticket } from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { objectStorageConfigured } from "../storage/objects";
import { retainAttachmentDraftInput } from "./commands";
import type { AttachmentObjects } from "./objects";
import {
  ATTACHMENT_DRAFT_KIND,
  ATTACHMENT_DRAFT_SCOPE_TYPE,
  type AttachmentDatabase,
  type AttachmentLimits,
  attachmentDraftIdempotencyKey,
  attachmentFields,
  configuredAttachmentLimits,
  draftOperationMatchesAttachment,
  readableAttachmentIn,
  readVerifiedAttachmentBytes,
  requireReadyProjectAttachmentIn,
} from "./store-types";

export async function assertMessageAttachmentsIn(
  sql: DatabaseTransaction,
  projectID: string,
  userID: string,
  content: string,
) {
  let bytes = 0;
  for (const id of attachmentIDs(content)) {
    const asset = await requireReadyProjectAttachmentIn(
      sql,
      userID,
      projectID,
      id,
      "conflict",
      "A message attachment is not ready in this Project.",
    );
    bytes += asset.bytes;
  }
  if (bytes > configuredAttachmentLimits().messageBytes)
    throw new CommandError(
      "conflict",
      "The attachments in this message exceed the configured message size limit.",
    );
}

export async function retainAttachmentDraft(
  database: AttachmentDatabase,
  userID: string,
  projectID: string,
  draftID: string,
  raw: unknown,
) {
  const input = retainAttachmentDraftInput.parse(raw);
  return database.client.begin(async (sql) => {
    await projectAuthorityIn(sql, userID, projectID);
    const attachmentIds = [...new Set(input.ids)];
    for (const id of attachmentIds) {
      await requireReadyProjectAttachmentIn(
        sql,
        userID,
        projectID,
        id,
        "conflict",
        "A draft file is not ready in this Project.",
      );
    }
    const db = drizzleTransaction(sql);
    const [existingTicket] = await db
      .select({ id: ticket.id })
      .from(ticket)
      .where(eq(ticket.id, draftID));
    if (existingTicket) return {};
    const parsedDraftID = z.uuid().parse(draftID);
    const payload = {
      projectId: projectID,
      sequence: input.sequence,
      attachmentIds,
    };
    await db
      .insert(operation)
      .values({
        id: crypto.randomUUID(),
        kind: ATTACHMENT_DRAFT_KIND,
        scopeType: ATTACHMENT_DRAFT_SCOPE_TYPE,
        scopeId: parsedDraftID,
        idempotencyKey: attachmentDraftIdempotencyKey(parsedDraftID, userID),
        state: "draft",
        createdBy: userID,
        payload,
      })
      .onConflictDoUpdate({
        target: operation.idempotencyKey,
        set: {
          payload,
          updatedAt: expression`now()`,
        },
        setWhere: expression`${operation.kind}=${ATTACHMENT_DRAFT_KIND} AND ${operation.payload}->>'projectId'=${projectID} AND (${operation.payload}->>'sequence')::bigint<${input.sequence}`,
      });
    return {};
  });
}

export async function readAttachmentUsage(
  database: AttachmentDatabase,
  limits: AttachmentLimits,
  projectID: string,
  userID: string,
) {
  return database.client.begin(async (sql) => {
    await projectAuthorityIn(sql, userID, projectID);
    const [usage] = await drizzleTransaction(sql)
      .select({
        projectBytes: expression<number>`COALESCE(sum(${attachment.reservedBytes}),0)::float8`,
      })
      .from(attachment)
      .where(and(eq(attachment.projectId, projectID), ne(attachment.state, "deleted")));
    return {
      limits,
      usedBytes: usage?.projectBytes ?? 0,
      configured: objectStorageConfigured(),
    };
  });
}

export async function readAttachmentResponse(
  database: AttachmentDatabase,
  objects: AttachmentObjects,
  userID: string,
  id: string,
  page?: number,
) {
  const asset = await database.client.begin((sql) => readableAttachmentIn(sql, userID, id));
  if (asset.state !== "ready") throw new CommandError("conflict", "The attachment is not ready.");
  const part = asset.objects[page === undefined ? 0 : page + 1];
  if (!part) throw new CommandError("not-found", "Attachment page not found");
  const bytes = await readVerifiedAttachmentBytes(objects, part);
  // Recheck after storage I/O, without holding an authority lock during it.
  await database.client.begin((sql) => readableAttachmentIn(sql, userID, id));
  return new Response(new Uint8Array(bytes).buffer, {
    headers: {
      "content-type": part.mediaType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${part.mediaType.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

export async function readAttachmentForModel(
  database: AttachmentDatabase,
  objects: AttachmentObjects,
  userID: string,
  projectID: string,
  id: string,
  page = 0,
  offset = 0,
) {
  const asset = await database.client.begin((sql) =>
    requireReadyProjectAttachmentIn(
      sql,
      userID,
      projectID,
      id,
      "not-found",
      "Attachment is unavailable in this Project",
    ),
  );
  z.number().int().nonnegative().parse(page);
  z.number().int().nonnegative().max(asset.text.length).parse(offset);
  if (
    offset > 0 &&
    asset.text.charCodeAt(offset) >= 0xdc00 &&
    asset.text.charCodeAt(offset) <= 0xdfff
  )
    throw new CommandError(
      "conflict",
      "Use a returned nextOffset rather than splitting a Unicode character.",
    );
  let end = Math.min(asset.text.length, offset + 16000);
  if (
    end < asset.text.length &&
    asset.text.charCodeAt(end - 1) >= 0xd800 &&
    asset.text.charCodeAt(end - 1) <= 0xdbff
  )
    end--;
  const preview = asset.objects[page + 1];
  if (page > 0 && !preview) throw new CommandError("not-found", "Attachment page not found");
  const image = preview ? await readVerifiedAttachmentBytes(objects, preview) : undefined;
  await database.client.begin((sql) => readableAttachmentIn(sql, userID, id));
  return {
    id,
    name: asset.name,
    sha256: asset.sha256,
    pages: asset.objects.length - 1,
    page: preview ? page : null,
    imageLabel: preview?.name ?? null,
    text: asset.text.slice(offset, end),
    nextOffset: asset.text.length > end ? end : null,
    ...(image
      ? { image: Buffer.from(image).toString("base64"), mediaType: "image/jpeg" as const }
      : {}),
  };
}

export async function sweepUnreferencedAttachments(
  database: AttachmentDatabase,
  objects: AttachmentObjects,
) {
  // Accounted bytes are released only after every recorded owned key is deleted.
  // Never expire a file referenced by a draft, revision, chat or admitted turn.
  const candidates = await database.db
    .select({ id: attachment.id })
    .from(attachment)
    .where(
      and(
        inArray(attachment.state, ["uploading", "failed", "ready", "deleting"]),
        lt(attachment.createdAt, expression`now()-interval '1 day'`),
        or(isNull(attachment.uploadExpiresAt), lt(attachment.uploadExpiresAt, expression`now()`)),
        not(
          exists(
            database.db
              .select({ id: attachmentReference.attachmentId })
              .from(attachmentReference)
              .where(eq(attachmentReference.attachmentId, attachment.id)),
          ),
        ),
        not(
          exists(
            database.db
              .select({ id: operation.id })
              .from(operation)
              .where(
                draftOperationMatchesAttachment(
                  expression`(${operation.payload}->'attachmentIds') ? ${attachment.id}::text`,
                  expression`${operation.payload}->>'projectId'=${attachment.projectId}::text`,
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(attachment.createdAt), asc(attachment.id))
    .limit(100);
  for (const candidate of candidates) {
    const row = await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const [row] = await db
        .select({ objects: attachmentFields.objects })
        .from(attachment)
        .where(and(eq(attachment.id, candidate.id), ne(attachment.state, "deleted")))
        .for("update");
      const [reference] = await db
        .select({ attachmentId: attachmentReference.attachmentId })
        .from(attachmentReference)
        .where(eq(attachmentReference.attachmentId, candidate.id))
        .limit(1);
      if (!row || reference) return undefined;
      const [draft] = await db
        .select({ id: operation.id })
        .from(operation)
        .where(
          draftOperationMatchesAttachment(
            expression`(${operation.payload}->'attachmentIds') ? ${candidate.id}`,
          ),
        )
        .limit(1);
      if (draft) return undefined;
      await db.update(attachment).set({ state: "deleting" }).where(eq(attachment.id, candidate.id));
      return row;
    });
    if (!row) continue;
    for (const object of row.objects) await objects.remove(object.key);
    await database.db
      .update(attachment)
      .set({ state: "deleted", deletedAt: expression`now()` })
      .where(and(eq(attachment.id, candidate.id), eq(attachment.state, "deleting")));
  }
}
