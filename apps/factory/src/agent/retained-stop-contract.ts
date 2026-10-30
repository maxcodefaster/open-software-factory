import { z } from "zod";
import upstream from "../../../../upstream.json";

export const retainedStopInput = z
  .object({
    stopID: z.uuid(),
    attemptID: z.uuid(),
    sessionID: z.string().regex(/^ses_[a-zA-Z0-9_-]+$/),
    promptID: z.string().regex(/^msg_[a-zA-Z0-9_-]+$/),
    modelID: z.string().min(1).max(200),
    version: z.literal(upstream.openCode.version),
  })
  .strict();
export const retainedStopResult = retainedStopInput.extend({
  confirmed: z.literal(true),
  nativeProcessExited: z.literal(true),
});
