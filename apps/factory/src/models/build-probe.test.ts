import { expect, test } from "bun:test";
import { fakeResponsesOutput } from "../../../../test/support/fake-openai-responses";
import type { UsageEntry } from "../usage/journal";
import { probeBuildModel } from "./build-probe";

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
    [401, "invalid-credentials"],
    [403, "model-denied"],
    [429, "rate-limited"],
  ] as const) {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json({ error: { message: "owned-sensitive-error" } }, { status });
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
