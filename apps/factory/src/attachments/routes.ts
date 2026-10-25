import { CommandError } from "../command-error";
import { json } from "../http";
import type { createAttachmentStore } from "./store";

async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit)
    throw new CommandError("conflict", "The upload exceeds its size limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new CommandError("conflict", "The upload body is missing.");
  const chunks: Uint8Array[] = [];
  let size = 0,
    expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, 30_000);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CommandError("conflict", "The upload exceeds its size limit.");
      }
      chunks.push(chunk.value);
    }
    if (expired) throw new CommandError("conflict", "The upload timed out. Retry it explicitly.");
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export function createAttachmentRoutes(store: ReturnType<typeof createAttachmentStore>) {
  // Raw file upload and protected downloads are HTTP byte protocols. Metadata,
  // upload intent and private draft retention use named Server Functions.
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const attachment = /^\/api\/attachments\/([a-f0-9-]{36})(?:\/(previews\/(\d+)))?$/.exec(
      url.pathname,
    );
    if (!attachment) return undefined;
    const id = attachment[1]!;
    if (request.method === "GET") {
      return store.read(
        userID,
        id,
        attachment[3] === undefined ? undefined : Number(attachment[3]),
      );
    }
    if (request.method === "PUT" && !attachment[2]) {
      const metadata = await store.metadata(userID, id);
      return json(
        await store.upload(
          userID,
          id,
          await boundedBody(request, Math.min(metadata.bytes, store.limits.fileBytes)),
        ),
      );
    }
    return new Response(null, { status: 405 });
  };
}
