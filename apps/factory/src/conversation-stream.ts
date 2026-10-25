import { type ConversationStreamEvent, conversationStreamEventSchema } from "./api-contracts";

// Consume one admitted command. Only read-only observations may reconnect.
export async function streamConversation(
  open: (signal: AbortSignal) => Promise<ReadableStream<ConversationStreamEvent>>,
  options: { signal?: AbortSignal | undefined },
  observe: (event: ConversationStreamEvent) => void,
) {
  const detach = new AbortController();
  const signal = AbortSignal.any([
    detach.signal,
    AbortSignal.timeout(75_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let reader: ReadableStreamDefaultReader<ConversationStreamEvent> | undefined;
  const cancel = () => {
    void reader?.cancel(signal.reason).catch(() => {});
  };
  try {
    reader = (await open(signal)).getReader();
    signal.addEventListener("abort", cancel, { once: true });
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done)
        throw new Error(
          "The response stream disconnected. Your saved message will not be sent again.",
        );
      const parsed = conversationStreamEventSchema.safeParse(chunk.value);
      if (!parsed.success)
        throw new Error(
          "Factory returned an invalid response stream. Your saved message will not be sent again.",
        );
      const event = parsed.data;
      if (event.type === "error") throw new Error(event.error);
      observe(event);
      if (event.type === "complete") return event.conversation;
    }
  } finally {
    // A decoded nested stream has its own queue. Close this invocation's
    // multiplexed wire too, without interrupting the admitted controller work.
    signal.removeEventListener("abort", cancel);
    detach.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
