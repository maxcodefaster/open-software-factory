import {
  type ConversationStreamEvent,
  conversationStreamEventSchema,
  conversationViewSchema,
} from "./api-contracts";

const invalidStream =
  "Factory returned an invalid response stream. Your saved message will not be sent again.";

export async function streamConversation(
  path: string,
  options: RequestInit,
  observe: (event: ConversationStreamEvent) => void,
) {
  const headers = new Headers(options.headers);
  headers.set("accept", "text/event-stream");
  // The server turn has a 60-second deadline. A lost HTTP connection must not
  // keep the composer pending forever, and detaching never retries paid work.
  const deadline = AbortSignal.timeout(75_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const response = await fetch(path, { ...options, headers, signal });
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof value?.error === "string" ? value.error : `Request failed with ${response.status}`,
    );
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const conversation = conversationViewSchema.parse(await response.json());
    observe({ type: "complete", conversation });
    return conversation;
  }
  if (!response.body) throw new Error("The response stream is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        if (boundary.index > 2 * 1024 * 1024) throw new Error("The response stream is too large.");
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          throw new Error(invalidStream);
        }
        const parsed = conversationStreamEventSchema.safeParse(value);
        if (!parsed.success) throw new Error(invalidStream);
        const event = parsed.data;
        if (event.type === "error") throw new Error(event.error);
        observe(event);
        if (event.type === "complete") return event.conversation;
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error("The response stream is too large.");
      if (chunk.done)
        throw new Error(
          "The response stream disconnected. Your saved message will not be sent again.",
        );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
