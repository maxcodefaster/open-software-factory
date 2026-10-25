import type { ConvertedAttachment } from "./conversion-result";

let activeConversions = 0;

// Keep coordination in Factory; load native conversion engines only in the owned worker.
export async function processAttachment(
  data: Uint8Array,
  mediaType: string,
): Promise<ConvertedAttachment> {
  if (activeConversions >= 2)
    throw new Error(
      "File processing is busy. Retry the upload explicitly after another file finishes.",
    );
  activeConversions++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./conversion-worker.ts", import.meta.url).href);
    const running = worker;
    return await new Promise<ConvertedAttachment>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("File processing timed out. Attach a smaller document.")),
        60_000,
      );
      running.onmessage = (
        event: MessageEvent<{ result?: ConvertedAttachment; error?: string }>,
      ) => {
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error ?? "File processing failed."));
      };
      running.onerror = () => {
        reject(new Error("File processing failed. Check the document and try again."));
      };
      running.postMessage({ data, mediaType });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    worker?.terminate();
    activeConversions--;
  }
}
