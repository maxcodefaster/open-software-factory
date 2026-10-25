import { z } from "zod";

export const retainAttachmentDraftInput = z.strictObject({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ids: z.array(z.uuid()).max(512),
});
