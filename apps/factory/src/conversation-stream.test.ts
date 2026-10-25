import { expect, test } from "bun:test";
import type { ConversationStreamEvent, ConversationView } from "./api-contracts";
import { streamConversation } from "./conversation-stream";

const conversation: ConversationView = {
  id: "owned",
  projectId: "owned",
  mode: "plan",
  version: 1,
  contextId: null,
  activeCodingContextId: null,
  isActiveCoding: false,
  contexts: [],
  codingHistory: null,
  entries: [],
};
const turnId = crypto.randomUUID();

test("native conversation events publish Unicode text before completion and release the invocation wire", async () => {
  const release = Promise.withResolvers<void>(),
    observed = Promise.withResolvers<string>();
  let wire: AbortSignal | undefined,
    requests = 0;
  const pending = streamConversation(
    async (signal) => {
      wire = signal;
      requests++;
      return new ReadableStream<ConversationStreamEvent>({
        async start(controller) {
          controller.enqueue({ type: "admitted", turnId });
          controller.enqueue({ type: "answer", turnId, text: "**Grüße** 👋" });
          await release.promise;
          controller.enqueue({ type: "complete", conversation });
          controller.close();
        },
      });
    },
    {},
    (event) => {
      if (event.type === "answer") observed.resolve(event.text);
    },
  );
  try {
    expect(await observed.promise).toBe("**Grüße** 👋");
    expect(wire?.aborted).toBe(false);
    release.resolve();
    expect(await pending).toEqual(conversation);
    expect(requests).toBe(1);
    expect(wire?.aborted).toBe(true);
  } finally {
    release.resolve();
    await pending.catch(() => {});
  }
});

test.each([
  { events: [{ type: "error", error: "Response failed" }], error: "Response failed" },
  { events: [{ type: "answer", turnId, text: "Incomplete" }], error: "disconnected" },
  { events: [{ type: "unknown" }], error: "invalid response stream" },
  { events: ["provider-secret-not-an-event"], error: "invalid response stream" },
])("native conversation failure never reopens the command", async ({ events, error }) => {
  let requests = 0;
  const pending = streamConversation(
    async () => {
      requests++;
      return new ReadableStream<ConversationStreamEvent>({
        start(controller) {
          for (const event of events) controller.enqueue(event as ConversationStreamEvent);
          controller.close();
        },
      });
    },
    {},
    () => {},
  );
  await expect(pending).rejects.toThrow(error);
  expect(requests).toBe(1);
});

test("a caller detaches a stalled native conversation without reopening it", async () => {
  const admitted = Promise.withResolvers<void>(),
    abort = new AbortController();
  let requests = 0,
    detached = false;
  const pending = streamConversation(
    async () => {
      requests++;
      return new ReadableStream<ConversationStreamEvent>({
        start(controller) {
          controller.enqueue({ type: "admitted", turnId });
        },
        cancel() {
          detached = true;
        },
      });
    },
    { signal: abort.signal },
    () => admitted.resolve(),
  );
  void pending.catch(() => {});
  await admitted.promise;
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(detached).toBe(true);
  expect(requests).toBe(1);
});
