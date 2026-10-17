import { expect, test } from "bun:test";
import type { ConversationStreamEvent, ConversationView } from "./api-contracts";
import { streamConversation } from "./conversation-stream";

const conversation: ConversationView = {
  id: "owned",
  projectId: "owned",
  mode: "plan",
  version: 1,
  entries: [],
};
const turnId = crypto.randomUUID();

test("browser transport reads split UTF-8 and SSE frames before completion", async () => {
  const release = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("accept")).toBe("text/event-stream");
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (event: ConversationStreamEvent) => {
              for (const byte of encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`))
                controller.enqueue(new Uint8Array([byte]));
            };
            send({ type: "admitted", turnId });
            send({ type: "answer", turnId, text: "**Grüße** 👋" });
            await release.promise;
            send({ type: "complete", conversation });
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const pending = streamConversation(
    `http://127.0.0.1:${server.port}`,
    { method: "POST" },
    (event) => {
      if (event.type === "answer") observed.resolve(event.text);
    },
  );
  try {
    expect(await observed.promise).toBe("**Grüße** 👋");
    release.resolve();
    expect(await pending).toEqual(conversation);
  } finally {
    release.resolve();
    await pending.catch(() => {});
    await server.stop(true);
  }
});

test.each([
  { body: 'data: {"type":"error","error":"Response failed"}\n\n', error: "Response failed" },
  {
    body: `data: ${JSON.stringify({ type: "answer", turnId, text: "Incomplete" })}\n\n`,
    error: "disconnected",
  },
  { body: 'data: {"type":"unknown"}\n\n', error: "invalid response stream" },
  { body: "data: provider-secret-not-json\n\n", error: "invalid response stream" },
])("browser transport rejects failure without replaying input", async ({ body, error }) => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const pending = streamConversation(
      `http://127.0.0.1:${server.port}`,
      { method: "POST" },
      () => {},
    );
    if (error) await expect(pending).rejects.toThrow(error);
    else await expect(pending).rejects.toThrow();
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("a caller can detach a stalled stream without another request", async () => {
  let requests = 0;
  const first = Promise.withResolvers<void>();
  const abort = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ type: "admitted", turnId })}\n\n`),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const pending = streamConversation(
    `http://127.0.0.1:${server.port}`,
    { method: "POST", signal: abort.signal },
    () => first.resolve(),
  );
  void pending.catch(() => {});
  try {
    await first.promise;
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(requests).toBe(1);
  } finally {
    abort.abort();
    await pending.catch(() => {});
    await server.stop(true);
  }
});

test("browser transport accepts the existing JSON command response", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(conversation),
  });
  try {
    expect(await streamConversation(`http://127.0.0.1:${server.port}`, {}, () => {})).toEqual(
      conversation,
    );
  } finally {
    await server.stop(true);
  }
});
