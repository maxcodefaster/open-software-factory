import { expect, test } from "bun:test";
import { AIError, ai } from "@opencode/ai";
import { model as openaiModel } from "@opencode/ai/providers/openai/responses";
import { fakeResponsesOutput } from "../../../../test/support/fake-openai-responses";
import type { UsageEntry } from "../usage/journal";
import { probeBuildModel } from "./build-probe";

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned probe did not finish")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("official OpenCode Promise cancellation aborts fetch, not just the caller's wait", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new DOMException("owned-stop", "AbortError");
  const pending = ai.generate(
    {
      model: openaiModel("owned-model", {
        apiKey: "owned-key",
        baseURL: "https://owned-endpoint.invalid/v1",
      }),
      prompt: "Check cancellation.",
      fetch: Object.assign(
        async (_request: string | URL | Request, init?: RequestInit) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Native request is missing its AbortSignal");
          started.resolve(signal);
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
        { preconnect: fetch.preconnect },
      ),
    },
    { signal: controller.signal },
  );
  // Observe rejection immediately, including if setup fails before fetch.
  const result = pending.catch((cause: unknown) => cause);
  try {
    const transportSignal = await within(started.promise);
    controller.abort(reason);
    expect(await within(result)).toBe(reason);
    await within(aborted.promise);
    expect(transportSignal.aborted).toBe(true);
  } finally {
    controller.abort(reason);
    await result;
  }
});

test("official OpenCode Promise errors retain native HTTP diagnostics without retrying", async () => {
  let requests = 0;
  const cause = await ai
    .generate({
      model: openaiModel("owned-model", {
        apiKey: "owned-key",
        baseURL: "https://owned-endpoint.invalid/v1",
      }),
      prompt: "Check HTTP errors.",
      fetch: Object.assign(
        async () => {
          requests++;
          return Response.json(
            { error: { message: "owned-sensitive-error" } },
            { status: 429, headers: { "x-ratelimit-remaining-tokens": "0" } },
          );
        },
        { preconnect: fetch.preconnect },
      ),
    })
    .catch((cause: unknown) => cause);
  expect(cause).toBeInstanceOf(AIError);
  if (!(cause instanceof AIError)) throw new Error("Missing native AIError");
  expect(cause.status).toBe(429);
  expect(cause.reason.http?.headers["x-ratelimit-remaining-tokens"]).toBe("0");
  expect(requests).toBe(1);
});

test.each(["medium", "high", "xhigh", "max"] as const)(
  "native OpenCode uses Responses with %s reasoning and a real structured tool call",
  async (reasoningEffort) => {
    let requests = 0;
    const lifecycle: string[] = [];
    const entries: UsageEntry[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        expect(lifecycle).toEqual(["begin"]);
        expect(new URL(request.url).pathname).toBe("/v1/responses");
        expect(request.headers.get("authorization")).toBe("Bearer owned-native-key");
        const body = await request.json();
        expect(body.model).toBe("gpt-6.1-sol");
        expect(body.reasoning.effort).toBe(reasoningEffort);
        expect(body.store).toBe(false);
        expect(body.include).toContain("reasoning.encrypted_content");
        expect(body.max_output_tokens).toBe(4096);
        expect(body.tools).toHaveLength(1);
        expect(body.tool_choice.name).toBe("factory_connection_probe");
        const item = {
          id: "owned-item",
          call_id: "owned-tool",
          type: "function_call" as const,
          name: "factory_connection_probe",
          arguments: JSON.stringify({ verified: true, value: "factory-connection-ok" }),
        };
        const response = fakeResponsesOutput(item);
        response.headers.set("x-ratelimit-limit-tokens", "30000");
        const frames = (await response.text())
          .trim()
          .split("\n\n")
          .map((frame) => {
            const event = JSON.parse(frame.slice("data: ".length));
            if (event.type === "response.completed")
              event.response.usage = {
                input_tokens: 100,
                output_tokens: 50,
                input_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
                output_tokens_details: { reasoning_tokens: 30 },
              };
            return `data: ${JSON.stringify(event)}\n\n`;
          });
        return new Response(frames.join(""), { headers: response.headers });
      },
    });
    try {
      const result = await probeBuildModel({
        connection: {
          provider: "openai",
          apiKey: "owned-native-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
        modelId: "gpt-6.1-sol",
        reasoningEffort,
        signal: AbortSignal.timeout(3000),
        usageSink: {
          async begin() {
            lifecycle.push("begin");
          },
          async record(entry) {
            lifecycle.push("record");
            entries.push(entry);
          },
          async settle(outcome) {
            lifecycle.push(outcome);
          },
        },
      });
      expect(result).toMatchObject({
        status: "ready",
        toolCall: true,
        structuredOutput: true,
        limits: { tokens: 30000 },
      });
      expect(requests).toBe(1);
      expect(lifecycle).toEqual(["begin", "record", "completed"]);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        eventID: "step:1",
        source: "step",
        outcome: "completed",
        counters: { input: 55, output: 50, cacheRead: 40, cacheWrite: 5, reasoning: 30 },
      });
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["anthropic", "deepseek"] as const)(
  "Promise Build probe preserves native %s transport, tool schema, usage and limits",
  async (provider) => {
    let requests = 0;
    const entries: UsageEntry[] = [];
    const lifecycle: string[] = [];
    const modelID = provider === "anthropic" ? "claude-haiku-4-5" : "deepseek-reasoner";
    const argumentsJSON = JSON.stringify({ verified: true, value: "factory-connection-ok" });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        expect(lifecycle).toEqual(["begin"]);
        expect(new URL(request.url).pathname).toBe(
          provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
        );
        expect(request.headers.get(provider === "anthropic" ? "x-api-key" : "authorization")).toBe(
          provider === "anthropic" ? "owned-native-key" : "Bearer owned-native-key",
        );
        if (provider === "anthropic") {
          expect(request.headers.get("authorization")).toBeNull();
          expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
        }
        const body = await request.json();
        expect(body.model).toBe(modelID);
        expect(body.stream).toBe(true);
        const schema =
          provider === "anthropic" ? body.tools[0].input_schema : body.tools[0].function.parameters;
        expect(schema).toMatchObject({
          type: "object",
          properties: { verified: { const: true }, value: { const: "factory-connection-ok" } },
          required: ["verified", "value"],
          additionalProperties: false,
        });
        const events =
          provider === "anthropic"
            ? [
                {
                  type: "message_start",
                  message: {
                    id: "msg_owned",
                    type: "message",
                    role: "assistant",
                    model: modelID,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                      input_tokens: 100,
                      output_tokens: 0,
                      cache_read_input_tokens: 40,
                      cache_creation_input_tokens: 5,
                    },
                  },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "owned-tool",
                    name: "factory_connection_probe",
                    input: {},
                  },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "input_json_delta", partial_json: argumentsJSON },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "tool_use", stop_sequence: null },
                  usage: { output_tokens: 50 },
                },
                { type: "message_stop" },
              ]
            : [
                {
                  id: "chatcmpl_owned",
                  model: modelID,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "owned-tool",
                            type: "function",
                            function: {
                              name: "factory_connection_probe",
                              arguments: argumentsJSON,
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "chatcmpl_owned",
                  model: modelID,
                  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 50,
                    prompt_cache_hit_tokens: 40,
                    prompt_cache_miss_tokens: 60,
                    completion_tokens_details: { reasoning_tokens: 30 },
                  },
                },
              ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream", "x-ratelimit-limit-tokens": "20000" },
        });
      },
    });
    try {
      const result = await probeBuildModel({
        connection: {
          provider,
          apiKey: "owned-native-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
        modelId: modelID,
        signal: AbortSignal.timeout(3000),
        usageSink: {
          async begin() {
            lifecycle.push("begin");
          },
          async record(entry) {
            entries.push(entry);
            lifecycle.push("record");
          },
          async settle(outcome) {
            lifecycle.push(outcome);
          },
        },
      });
      expect(result).toMatchObject({
        status: "ready",
        toolCall: true,
        structuredOutput: true,
        limits: { tokens: 20000 },
      });
      expect(requests).toBe(1);
      expect(lifecycle).toEqual(["begin", "record", "completed"]);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.counters).toMatchObject({
        input: provider === "anthropic" ? 100 : 60,
        output: 50,
        cacheRead: 40,
        cacheWrite: provider === "anthropic" ? 5 : null,
        reasoning: provider === "anthropic" ? null : 30,
      });
    } finally {
      await server.stop(true);
    }
  },
);

test("native Build probe does not infer or settle usage after admission is denied", async () => {
  let requests = 0;
  const lifecycle: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(null, { status: 500 });
    },
  });
  try {
    const result = await probeBuildModel({
      connection: {
        apiKey: "owned-native-key",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
      },
      modelId: "owned-build-model",
      signal: AbortSignal.timeout(3000),
      usageSink: {
        async begin() {
          lifecycle.push("begin");
          throw new Error("Owned allowance denied admission");
        },
        async record() {
          lifecycle.push("record");
        },
        async settle() {
          lifecycle.push("settle");
        },
      },
    });
    expect(result.status).toBe("unavailable");
    expect(requests).toBe(0);
    expect(lifecycle).toEqual(["begin"]);
  } finally {
    await server.stop(true);
  }
});

test("Stop during Build admission does not start transport and settles interrupted usage", async () => {
  let requests = 0;
  const controller = new AbortController();
  const lifecycle: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(null, { status: 500 });
    },
  });
  try {
    const result = await probeBuildModel({
      connection: {
        apiKey: "owned-native-key",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
      },
      modelId: "owned-build-model",
      signal: controller.signal,
      usageSink: {
        async begin() {
          lifecycle.push("begin");
          controller.abort();
        },
        async record() {
          lifecycle.push("record");
        },
        async settle(outcome) {
          lifecycle.push(outcome);
        },
      },
    });
    expect(result.status).toBe("stopped");
    expect(requests).toBe(0);
    expect(lifecycle).toEqual(["begin", "record", "interrupted"]);
  } finally {
    await server.stop(true);
  }
});

test.each([false, "true", null])(
  "Build probe rejects a tool result with verified=%j after the Promise migration",
  async (verified) => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return fakeResponsesOutput({
          id: "owned-item",
          call_id: "owned-tool",
          type: "function_call",
          name: "factory_connection_probe",
          arguments: JSON.stringify({ verified, value: "factory-connection-ok" }),
        });
      },
    });
    try {
      const result = await probeBuildModel({
        connection: {
          apiKey: "owned-native-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
        modelId: "owned-build-model",
        signal: AbortSignal.timeout(3000),
      });
      expect(result).toMatchObject({
        status: "unsupported",
        toolCall: true,
        structuredOutput: false,
      });
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  },
);

test("failed Build response decoding retains headers and records unknown usage once", async () => {
  const entries: UsageEntry[] = [];
  const lifecycle: string[] = [];
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response("data: not-json\n\n", {
        headers: { "content-type": "text/event-stream", "x-ratelimit-limit-tokens": "20000" },
      });
    },
  });
  try {
    const result = await probeBuildModel({
      connection: {
        apiKey: "owned-native-key",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
      },
      modelId: "owned-build-model",
      signal: AbortSignal.timeout(3000),
      usageSink: {
        async begin() {
          lifecycle.push("begin");
        },
        async record(entry) {
          entries.push(entry);
          lifecycle.push("record");
        },
        async settle(outcome) {
          lifecycle.push(outcome);
        },
      },
    });
    expect(result).toMatchObject({ status: "unavailable", limits: { tokens: 20000 } });
    expect(requests).toBe(1);
    expect(lifecycle).toEqual(["begin", "record", "failed"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventID: "unobserved",
      counters: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
    });
  } finally {
    await server.stop(true);
  }
});

test("Stop interrupts an in-flight native Build probe and settles its unknown usage once", async () => {
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const lifecycle: string[] = [];
  const entries: UsageEntry[] = [];
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      started.resolve();
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const pending = probeBuildModel({
    connection: {
      apiKey: "owned-native-key",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
    },
    modelId: "owned-build-model",
    signal: controller.signal,
    usageSink: {
      async begin() {
        lifecycle.push("begin");
      },
      async record(entry) {
        lifecycle.push("record");
        entries.push(entry);
      },
      async settle(outcome) {
        lifecycle.push(outcome);
      },
    },
  });
  try {
    await Promise.race([
      started.promise,
      Bun.sleep(3000).then(() => {
        throw new Error("Owned native probe request did not arrive");
      }),
    ]);
    controller.abort();
    expect((await pending).status).toBe("stopped");
    expect(requests).toBe(1);
    expect(lifecycle).toEqual(["begin", "record", "interrupted"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventID: "unobserved",
      source: "unobserved",
      outcome: "interrupted",
      counters: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
    });
  } finally {
    controller.abort();
    await pending;
    await server.stop(true);
  }
});

test("native OpenCode provider errors and Stop are sanitized and never retried", async () => {
  for (const [status, expected] of [
    [400, "unsupported"],
    [401, "invalid-credentials"],
    [403, "model-denied"],
    [404, "model-denied"],
    [422, "unsupported"],
    [429, "rate-limited"],
    [500, "unavailable"],
  ] as const) {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json(
          { error: { message: "owned-sensitive-error" } },
          { status, headers: { "x-ratelimit-remaining-tokens": "0" } },
        );
      },
    });
    try {
      const result = await probeBuildModel({
        connection: {
          provider: "openai",
          apiKey: "owned-sensitive-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
        modelId: "owned-build-model",
        signal: AbortSignal.timeout(3000),
      });
      expect(result.status).toBe(expected);
      expect(result.limits.remainingTokens).toBe(0);
      expect(JSON.stringify(result)).not.toContain("owned-sensitive");
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  }
  const stopped = await probeBuildModel({
    connection: { apiKey: "unused" },
    modelId: "unused",
    signal: AbortSignal.abort(),
  });
  expect(stopped.status).toBe("stopped");
});
