import { and, eq, sql as expression, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { attachmentInput } from "#conversation-domain/attachments";
import { drizzleTransaction } from "#db/client";
import { attachment, operation } from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { type AttachmentObjects, attachmentDigest } from "./objects";
import {
  ATTACHMENT_STORAGE_IDEMPOTENCY_KEY,
  ATTACHMENT_STORAGE_KIND,
  type AttachmentConverter,
  type AttachmentDatabase,
  type AttachmentLimits,
  attachmentFields,
  attachmentSummaryFromRow,
  readableAttachmentIn,
  type StoredAttachmentObject,
} from "./store-types";

const USER_VISIBLE_CONVERSION_ERROR =
  /^(?:The file content|This (?:image|PDF|DOCX)|Text files|Extracted text|Image processing|Use a regular DOCX|File processing)/;

function activeUploadWhere(id: string, token: string, checkExpiry = true) {
  return and(
    eq(attachment.id, id),
    eq(attachment.state, "uploading"),
    eq(attachment.uploadToken, token),
    checkExpiry ? gt(attachment.uploadExpiresAt, expression`clock_timestamp()`) : undefined,
  );
}

async function attachmentStorageId(database: AttachmentDatabase) {
  const [storage] = await database.db
    .select({ id: operation.id })
    .from(operation)
    .where(
      and(
        eq(operation.kind, ATTACHMENT_STORAGE_KIND),
        eq(operation.idempotencyKey, ATTACHMENT_STORAGE_IDEMPOTENCY_KEY),
      ),
    );
  if (!storage) throw new Error("Attachment storage identity is unavailable");
  return storage.id;
}

function recordedManifestDiffers(
  current: { objects: StoredAttachmentObject[]; text: string },
  manifest: StoredAttachmentObject[],
  text: string,
) {
  return (
    current.objects.length > 0 &&
    (current.text !== text ||
      current.objects.length !== manifest.length ||
      !current.objects.every(
        (part, index) =>
          part.key === manifest[index]?.key &&
          part.sha256 === manifest[index]?.sha256 &&
          part.bytes === manifest[index]?.bytes &&
          part.mediaType === manifest[index]?.mediaType,
      ))
  );
}

export async function beginAttachmentUpload(
  database: AttachmentDatabase,
  limits: AttachmentLimits,
  userID: string,
  raw: unknown,
) {
  const input = attachmentInput.parse(raw);
  if (input.bytes > limits.fileBytes)
    throw new CommandError("conflict", `Each file must be at most ${limits.fileBytes} bytes.`);
  if (/[\\/\r\n\0]/.test(input.name))
    throw new CommandError("conflict", "Use a plain file name without path separators.");
  return database.client.begin(async (sql) => {
    await projectAuthorityIn(sql, userID, input.projectId);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`attachment:${input.id}`}))`;
    const db = drizzleTransaction(sql);
    const [previous] = await db
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.id, input.id));
    if (previous) {
      const row = await readableAttachmentIn(sql, userID, input.id);
      if (
        row.ownerId !== userID ||
        row.projectId !== input.projectId ||
        row.name !== input.name ||
        row.mediaType !== input.mediaType ||
        row.sha256 !== input.sha256 ||
        row.bytes !== input.bytes ||
        row.draftId !== (input.draftId ?? null)
      )
        throw new CommandError(
          "conflict",
          "The upload identity was reused with different content.",
        );
      return attachmentSummaryFromRow(row);
    }
    await db.insert(attachment).values({
      id: input.id,
      projectId: input.projectId,
      ownerId: userID,
      draftId: input.draftId ?? null,
      name: input.name,
      mediaType: input.mediaType,
      sha256: input.sha256,
      byteLength: input.bytes,
      reservedBytes: input.bytes,
      state: "uploading",
    });
    return attachmentSummaryFromRow(await readableAttachmentIn(sql, userID, input.id));
  });
}

export async function uploadAttachmentData(
  database: AttachmentDatabase,
  objects: AttachmentObjects,
  convert: AttachmentConverter,
  userID: string,
  id: string,
  data: Uint8Array,
) {
  const token = crypto.randomUUID();
  const row = await database.client.begin(async (sql) => {
    const row = await readableAttachmentIn(sql, userID, id, true);
    if (row.ownerId !== userID) throw new CommandError("not-found", "Upload not found");
    if (row.bytes !== data.byteLength || row.sha256 !== attachmentDigest(data))
      throw new CommandError(
        "conflict",
        "The upload does not match its recorded size and content hash.",
      );
    if (row.state === "ready") return row;
    const [claimed] = await drizzleTransaction(sql)
      .update(attachment)
      .set({
        state: "uploading",
        failure: null,
        uploadToken: token,
        uploadExpiresAt: expression`now()+interval '90 seconds'`,
      })
      .where(
        and(
          eq(attachment.id, id),
          inArray(attachment.state, ["uploading", "failed"]),
          or(isNull(attachment.uploadToken), lt(attachment.uploadExpiresAt, expression`now()`)),
        ),
      )
      .returning({ id: attachment.id });
    if (!claimed)
      throw new CommandError(
        "conflict",
        "This file is already being processed. Check its status before retrying.",
      );
    return row;
  });
  if (row.state === "ready") return attachmentSummaryFromRow(row);
  let conversionComplete = false;
  try {
    const converted = await convert(data, row.mediaType);
    conversionComplete = true;
    const parts = [{ name: row.name, mediaType: row.mediaType, data }, ...converted.previews];
    const storageId = await attachmentStorageId(database);
    const manifest: StoredAttachmentObject[] = parts.map((part, index) => ({
      key: `factory-attachments/${storageId}/${id}/${index}-${attachmentDigest(part.data)}`,
      name: part.name,
      mediaType: part.mediaType,
      bytes: part.data.byteLength,
      sha256: attachmentDigest(part.data),
    }));
    const reserved =
      manifest.reduce((sum, item) => sum + item.bytes, 0) + Buffer.byteLength(converted.text);
    await database.client.begin(async (sql) => {
      await projectAuthorityIn(sql, userID, row.projectId);
      const db = drizzleTransaction(sql);
      const [current] = await db
        .select({ objects: attachmentFields.objects, text: attachment.textContent })
        .from(attachment)
        .where(activeUploadWhere(id, token))
        .for("update");
      if (!current) throw new CommandError("conflict", "This upload no longer owns publication.");
      if (recordedManifestDiffers(current, manifest, converted.text))
        throw new CommandError(
          "conflict",
          "This upload already has a different recorded processing result. Choose the file again to start a new upload; the original intent is retained.",
        );
      // Persist every key before the first external write, including previews.
      await db
        .update(attachment)
        .set({ reservedBytes: reserved, objects: manifest, textContent: converted.text })
        .where(eq(attachment.id, id));
    });
    for (const [index, part] of parts.entries()) {
      await database.client.begin(async (sql) => {
        await projectAuthorityIn(sql, userID, row.projectId);
        const [current] = await drizzleTransaction(sql)
          .update(attachment)
          .set({ uploadExpiresAt: expression`clock_timestamp()+interval '90 seconds'` })
          .where(activeUploadWhere(id, token))
          .returning({ id: attachment.id });
        if (!current)
          throw new CommandError("conflict", "This upload no longer owns its file writes.");
      });
      const stored = manifest[index];
      if (!stored) throw new Error("Attachment processing lost its recorded object");
      await objects.put(stored.key, part.data, part.mediaType);
    }
    return await database.client.begin(async (sql) => {
      await projectAuthorityIn(sql, userID, row.projectId);
      const [published] = await drizzleTransaction(sql)
        .update(attachment)
        .set({
          state: "ready",
          completedAt: expression`now()`,
          uploadToken: null,
          uploadExpiresAt: null,
        })
        .where(activeUploadWhere(id, token))
        .returning({ id: attachment.id });
      if (!published)
        throw new CommandError("conflict", "Attachment publication is no longer current.");
      return attachmentSummaryFromRow(await readableAttachmentIn(sql, userID, id));
    });
  } catch (cause) {
    const message =
      cause instanceof CommandError
        ? cause.message
        : !conversionComplete &&
            cause instanceof Error &&
            USER_VISIBLE_CONVERSION_ERROR.test(cause.message)
          ? cause.message.slice(0, 500)
          : "File storage or processing is unavailable. Your document was not published. Retry the upload explicitly.";
    await database.db
      .update(attachment)
      .set({ state: "failed", failure: message, uploadToken: null, uploadExpiresAt: null })
      .where(activeUploadWhere(id, token, false));
    if (cause instanceof CommandError) throw cause;
    throw new CommandError("conflict", message);
  }
}
