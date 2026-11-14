export async function boundedSourceBody(
  request: Request,
  signal: AbortSignal = request.signal,
): Promise<Uint8Array<ArrayBuffer>> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  deadline.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  deadline.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      deadline.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 << 20) {
        void reader.cancel().catch(() => {});
        throw new Error("Source request exceeds 4 MiB");
      }
      chunks.push(chunk.value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return content;
  } finally {
    deadline.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
