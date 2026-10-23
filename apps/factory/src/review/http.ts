import { CommandError } from "../command-error";

export async function reviewRequestBody(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit)
    throw new CommandError("conflict", "Review request exceeds its size limit");
  const reader = request.body?.getReader();
  if (!reader) throw new CommandError("conflict", "Review request body is required");
  const parts: Uint8Array[] = [];
  let bytes = 0,
    expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 5_000);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new CommandError("conflict", "Review request exceeds its size limit");
      }
      parts.push(chunk.value);
    }
    if (expired)
      throw new CommandError("conflict", "Review upload timed out. No correction was started.");
    return Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
