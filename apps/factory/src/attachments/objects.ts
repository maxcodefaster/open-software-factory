import type { PrivateObjects } from "../storage/objects";

export {
  objectDigest as attachmentDigest,
  createPrivateObjects as createAttachmentObjects,
} from "../storage/objects";

export type AttachmentObjects = Pick<PrivateObjects, "put" | "read" | "remove">;
