import { convertAttachment } from "./conversion";

self.onmessage = async (event: MessageEvent<{ data: Uint8Array; mediaType: string }>) => {
  try {
    self.postMessage({ result: await convertAttachment(event.data.data, event.data.mediaType) });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : "File processing failed." });
  }
};
