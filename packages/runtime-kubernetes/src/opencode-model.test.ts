import { expect, test } from "bun:test";
import { openCodeModelConfiguration } from "./opencode-model";

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
