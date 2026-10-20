import { expect, test } from "bun:test";
import { openCodeModelConfiguration, openCodeModelMetadata } from "./opencode-model";

test("verified Sol model IDs pin native capabilities and limits without guessing deployment aliases", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-2026-09-29"])
    expect(openCodeModelMetadata("openai", id)).toEqual({
      name: id,
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    });
  expect(openCodeModelMetadata("openai", "custom-sol-deployment")).toEqual({
    name: "custom-sol-deployment",
  });
  expect(openCodeModelMetadata("anthropic", "gpt-6.1-sol")).toEqual({ name: "gpt-6.1-sol" });
});

test("new OpenAI Builds use native Responses, the admitted reasoning and stateless reasoning history", () => {
  for (const reasoningEffort of ["medium", "high", "xhigh", "max"] as const)
    expect(openCodeModelConfiguration({ modelID: "gpt-6.1-sol", reasoningEffort })).toEqual({
      package: "@opencode/ai/providers/openai/responses",
      settings: {
        reasoningEffort,
        store: false,
        include: ["reasoning.encrypted_content"],
      },
    });
});

test("frozen historical and other native provider configurations do not silently migrate", () => {
  expect(openCodeModelConfiguration({ modelID: "gpt-5.6-terra" })).toEqual({
    package: "@opencode/ai/providers/openai/chat",
    settings: { reasoningEffort: "none" },
  });
  expect(openCodeModelConfiguration({ modelID: "historical-model" }).settings).toEqual({});
  for (const provider of ["anthropic", "deepseek"] as const)
    expect(
      openCodeModelConfiguration({ provider, modelID: "native", reasoningEffort: "high" }),
    ).toEqual({ package: `@opencode/ai/providers/${provider}`, settings: {} });
});
