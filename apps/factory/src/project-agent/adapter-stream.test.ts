import { expect, test } from "bun:test";
import type { ProjectAgentOutput } from "../../../../packages/conversation-domain/src/conversation";
import { generateProjectResponse } from "./adapter";

const requirement = {
  summary: "Keep the page read-only",
  acceptanceCriteria: ["Show the account name"],
  nonGoals: [],
};
const planningOutputs = [
  {
    kind: "question",
    message: "Choose a scope",
    question: { type: "free-text", prompt: "Who uses this?", placeholder: "Audience" },
    citations: [],
  },
  {
    kind: "requirement",
    message: "Proposal ready",
    ticket: { title: "Show account", description: "Read-only account name" },
    requirement,
    citations: [],
  },
  {
    kind: "epic",
    message: "Grouping ready",
    proposal: {
      epic: { title: "Account", description: "Account views" },
      members: ["name", "email"].map((key) => ({
        key,
        existingTicketId: null,
        expectedVersion: null,
        title: `Show ${key}`,
        description: "Read-only",
        requirement,
        dependsOn: [],
      })),
    },
    citations: [],
  },
] satisfies ProjectAgentOutput[];

test("native stream coalesces a token burst without delaying first text or losing the tail", async () => {
  const release = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>();
  const parts: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (content: string, finished = false) =>
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: "owned",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "owned-stream",
                    choices: [
                      {
                        index: 0,
                        delta: finished ? {} : { role: "assistant", content },
                        finish_reason: finished ? "stop" : null,
                      },
                    ],
                  })}\n\n`,
                ),
              );
            send('{"output":{"kind":"answer","message":"First');
            await release.promise;
            for (let index = 0; index < 100; index++) {
              send(" x");
            }
            send(' Tail","citations":[]}}');
            send("", true);
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const pending = generateProjectResponse({
    mode: "investigate",
    modelId: "owned-stream",
    connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned" },
    prompt: "Say hello",
    history: [],
    signal: AbortSignal.timeout(3000),
    research: {
      search: async () => [],
      read: async () => {
        throw new Error("Unused");
      },
    },
    answerText: async (text) => {
      parts.push(text);
      first.resolve();
    },
  });
  void pending.catch(() => {});
  try {
    await first.promise;
    expect(parts).toEqual(["First"]);
    release.resolve();
    const result = await pending;
    expect(parts.at(-1)).toBe(`First${" x".repeat(100)} Tail`);
    expect(result).toMatchObject({ message: parts.at(-1) });
    expect(parts.length).toBeLessThan(15);
  } finally {
    release.resolve();
    await pending.catch(() => {});
    await provider.stop(true);
  }
});

test.each(planningOutputs)(
  "native stream never exposes partial $kind planning output",
  async (output) => {
    const parts: string[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const content = JSON.stringify({ output });
        const data = [
          {
            id: "owned",
            object: "chat.completion.chunk",
            created: 1,
            model: "owned-stream",
            choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
          },
          {
            id: "owned",
            object: "chat.completion.chunk",
            created: 1,
            model: "owned-stream",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        return new Response(
          `${data.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const result = await generateProjectResponse({
        mode: "plan",
        modelId: "owned-stream",
        connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned" },
        prompt: "Clarify",
        history: [],
        signal: AbortSignal.timeout(3000),
        research: {
          search: async () => [],
          read: async () => {
            throw new Error("Unused");
          },
        },
        answerText: async (text) => {
          parts.push(text);
        },
      });
      expect(result.kind).toBe(output.kind);
      expect(parts).toEqual([]);
    } finally {
      await provider.stop(true);
    }
  },
);

for (const modelId of ["owned-stream", "gpt-6-luna"]) {
  test(`native ${modelId} delivers answer text before provider completion`, async () => {
    const release = Promise.withResolvers<void>();
    const firstText = Promise.withResolvers<string>();
    let finished = false;
    let requests = 0;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const body = (await request.json()) as { stream?: boolean };
        const prefix = '{"output":{"kind":"answer","message":"Hello';
        const suffix = ' world","citations":[]}}';
        if (!body.stream) {
          await release.promise;
          return Response.json({
            id: "owned-stream",
            object: "chat.completion",
            created: 1,
            model: modelId,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: prefix + suffix },
                finish_reason: "stop",
              },
            ],
          });
        }
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              const emit = (event: unknown) =>
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              const delta = (content: string) =>
                modelId === "gpt-6-luna"
                  ? {
                      type: "response.output_text.delta",
                      item_id: "msg-owned",
                      output_index: 0,
                      delta: content,
                    }
                  : {
                      id: "owned-stream",
                      object: "chat.completion.chunk",
                      created: 1,
                      model: modelId,
                      choices: [
                        { index: 0, delta: { role: "assistant", content }, finish_reason: null },
                      ],
                    };
              if (modelId === "gpt-6-luna") {
                emit({
                  type: "response.created",
                  response: { id: "resp-owned", created_at: 1, model: modelId },
                });
                emit({
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "message", id: "msg-owned" },
                });
              }
              emit(delta(prefix));
              await release.promise;
              emit(delta(suffix));
              if (modelId === "gpt-6-luna") {
                emit({
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "message",
                    id: "msg-owned",
                    role: "assistant",
                    content: [{ type: "output_text", text: prefix + suffix, annotations: [] }],
                  },
                });
                emit({
                  type: "response.completed",
                  response: { usage: { input_tokens: 10, output_tokens: 5 } },
                });
              } else {
                emit({
                  id: "owned-stream",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: modelId,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const parts: string[] = [];
    const pending = generateProjectResponse({
      mode: "investigate",
      modelId,
      connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-fixture" },
      prompt: "Say hello",
      history: [],
      signal: AbortSignal.timeout(3000),
      research: {
        search: async () => [],
        read: async () => {
          throw new Error("Unused");
        },
      },
      answerText: async (text: string) => {
        parts.push(text);
        firstText.resolve(text);
      },
    }).finally(() => {
      finished = true;
    });
    // Observe failures immediately, even while the provider is held open.
    void pending.catch(() => {});
    try {
      expect(
        await Promise.race([
          firstText.promise,
          Bun.sleep(700).then(() => {
            throw new Error("No live answer text");
          }),
        ]),
      ).toBe("Hello");
      expect(finished).toBe(false);
      release.resolve();
      expect(await pending).toMatchObject({ kind: "answer", message: "Hello world" });
      expect(parts.at(-1)).toBe("Hello world");
      expect(requests).toBe(1);
    } finally {
      release.resolve();
      await pending.catch(() => {});
      await provider.stop(true);
    }
  });
}
