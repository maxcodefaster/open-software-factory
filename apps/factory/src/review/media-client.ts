import { z } from "zod";
import { protocolRequest } from "../api-client";

// HTML media needs authenticated, range-capable URLs. Exact JPEG uploads
// retain their HTTP boundary; Review decisions do not.
export function reviewMediaURL(changeID: string, mediaID: string) {
  return `/api/changes/${changeID}/review/media/${mediaID}`;
}
export async function uploadReviewStill(
  changeID: string,
  input: { id: string; frame: Blob; context: unknown },
) {
  const form = new FormData();
  form.set("id", input.id);
  form.set("frame", input.frame, "frame.jpg");
  form.set("context", JSON.stringify(input.context));
  return protocolRequest(
    z.object({ id: z.uuid(), page: z.string().optional() }),
    `/api/changes/${changeID}/review/stills`,
    { method: "POST", body: form },
  );
}
