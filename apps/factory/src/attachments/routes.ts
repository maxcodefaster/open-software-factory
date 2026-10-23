import { attachmentInput } from "../../../../packages/conversation-domain/src/attachments";
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
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const draft = /^\/api\/projects\/([a-f0-9-]{36})\/attachment-drafts\/([a-f0-9-]{36})$/.exec(
      url.pathname,
    );
    if (draft && request.method === "PUT")
      return json(
        await store.retainDraft(
          userID,
          draft[1]!,
          draft[2]!,
          JSON.parse(new TextDecoder().decode(await boundedBody(request, 65536))),
        ),
      );
    const project = /^\/api\/projects\/([a-f0-9-]{36})\/attachments$/.exec(url.pathname);
    if (project) {
      if (request.method === "GET") return json(await store.usage(project[1]!, userID));
      if (request.method === "POST") {
        const input = attachmentInput.parse(
          JSON.parse(new TextDecoder().decode(await boundedBody(request, 8192))),
        );
        if (input.projectId !== project[1])
          throw new CommandError("conflict", "Upload Project changed.");
        return json(await store.begin(userID, input), 201);
      }
      return new Response(null, { status: 405 });
    }
    const attachment =
      /^\/api\/attachments\/([a-f0-9-]{36})(?:\/(metadata|previews\/(\d+)))?$/.exec(url.pathname);
    if (!attachment) return undefined;
    const id = attachment[1]!;
    if (request.method === "GET") {
      if (attachment[2] === "metadata") return json(await store.metadata(userID, id));
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
