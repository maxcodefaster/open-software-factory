import { type AttachmentObjects, createAttachmentObjects } from "./objects";
import { processAttachment } from "./process";
import {
  readAttachmentForModel,
  readAttachmentResponse,
  readAttachmentUsage,
  retainAttachmentDraft,
  sweepUnreferencedAttachments,
} from "./store-references";
import {
  type AttachmentConverter,
  type AttachmentDatabase,
  attachmentSummaryFromRow,
  configuredAttachmentLimits,
  readableAttachmentIn,
} from "./store-types";
import { beginAttachmentUpload, uploadAttachmentData } from "./store-upload";

export {
  attachmentContextIn,
  freezeAttachmentContextIn,
  freezeFeedbackAttachmentsIn,
} from "./store-context";
export { assertMessageAttachmentsIn } from "./store-references";
export { configuredAttachmentLimits, readableAttachmentIn } from "./store-types";

export function createAttachmentStore(
  database: AttachmentDatabase,
  objects: AttachmentObjects = createAttachmentObjects(),
  convert: AttachmentConverter = processAttachment,
) {
  const limits = configuredAttachmentLimits();
  return {
    limits,
    retainDraft(userID: string, projectID: string, draftID: string, raw: unknown) {
      return retainAttachmentDraft(database, userID, projectID, draftID, raw);
    },
    usage(projectID: string, userID: string) {
      return readAttachmentUsage(database, limits, projectID, userID);
    },
    begin(userID: string, raw: unknown) {
      return beginAttachmentUpload(database, limits, userID, raw);
    },
    upload(userID: string, id: string, data: Uint8Array) {
      return uploadAttachmentData(database, objects, convert, userID, id, data);
    },
    async metadata(userID: string, id: string) {
      return database.client.begin(async (sql) =>
        attachmentSummaryFromRow(await readableAttachmentIn(sql, userID, id)),
      );
    },
    read(userID: string, id: string, page?: number) {
      return readAttachmentResponse(database, objects, userID, id, page);
    },
    modelRead(userID: string, projectID: string, id: string, page = 0, offset = 0) {
      return readAttachmentForModel(database, objects, userID, projectID, id, page, offset);
    },
    sweep() {
      return sweepUnreferencedAttachments(database, objects);
    },
  };
}
