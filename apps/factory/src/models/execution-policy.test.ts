import { expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  knownModelRejection,
  ModelExecutionBoundError,
  nativeAgentPolicy,
  nativeStepGuard,
} from "./execution-policy";
import { nativeModel } from "./native";

test("multimodal input has a separate bounded image allowance without relaxing authored text", async () => {
  const guard = nativeStepGuard({
    signal: AbortSignal.timeout(2000),
    maxInputBytes: 1024,
    maxMediaBytes: 2048,
  });
  const image = {
    type: "image-data",
    mediaType: "image/jpeg",
    data: Buffer.alloc(1200, 1).toString("base64"),
  };
  await guard({ messages: [{ role: "tool", content: [image] }], systemMessages: [] });
  expect(image.data.length).toBeGreaterThan(1024);
  await expect(
    guard({ messages: [{ role: "user", content: "x".repeat(1025) }], systemMessages: [] }),
  ).rejects.toBeInstanceOf(ModelExecutionBoundError);
  await expect(
    guard({
      messages: [
        { role: "tool", content: [{ ...image, data: Buffer.alloc(3000, 1).toString("base64") }] },
      ],
      systemMessages: [],
    }),
  ).rejects.toBeInstanceOf(ModelExecutionBoundError);
});

test("shared native policy removes processor retries and counts every tool-loop provider step", async () => {
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      return Response.json({
        id: "owned-policy",
        object: "chat.completion",
        created: 1,
        model: "owned-policy",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              tool_calls: [
                { id: "call-owned", type: "function", function: { name: "read", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    const agent = new Agent({
      id: "owned-policy",
      name: "Owned policy",
      ...nativeAgentPolicy,
      model: await nativeModel(
        { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-policy" },
        "owned-policy",
      ),
      instructions: "Read",
      tools: {
        read: createTool({
          id: "owned-read",
          description: "Read an owned fixture value",
          inputSchema: z.object({}),
          execute: async () => "Known",
        }),
      },
    });
    expect(await agent.listErrorProcessors()).toEqual([]);
    const budget = { remaining: 1 };
    await expect(
      agent.generate("Read", {
        maxSteps: 4,
        modelSettings: { maxRetries: 0 },
        prepareStep: nativeStepGuard({
          signal: AbortSignal.timeout(2000),
          requests: budget,
          maxInputBytes: 8192,
        }),
      }),
    ).rejects.toThrow("Model requests bound reached");
    expect(requests).toBe(1);
    expect(budget.remaining).toBe(0);
  } finally {
    await provider.stop(true);
  }
});

test("execution bounds and definite rejection distinguish unknown paid outcomes", async () => {
  expect(knownModelRejection({ cause: { statusCode: 429 } })).toBe(true);
  expect(knownModelRejection({ cause: { statusCode: 401 } })).toBe(true);
  expect(knownModelRejection({ statusCode: 503 })).toBe(false);
  expect(knownModelRejection(new DOMException("Timeout", "TimeoutError"))).toBe(false);
  await expect(
    nativeStepGuard({ signal: AbortSignal.timeout(1000), maxInputBytes: 10 })({
      messages: ["large input"],
      systemMessages: [],
    }),
  ).rejects.toBeInstanceOf(ModelExecutionBoundError);
});
