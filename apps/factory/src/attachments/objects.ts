import type { PrivateObjects } from "../storage/objects";

export {
  createPrivateObjects as createAttachmentObjects,
  objectDigest as attachmentDigest,
} from "../storage/objects";

export type AttachmentObjects = Pick<PrivateObjects, "put" | "read" | "remove">;
