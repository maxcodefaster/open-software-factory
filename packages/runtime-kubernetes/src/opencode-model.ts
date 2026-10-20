import type { CodingReasoning } from "../../conversation-domain/src/model-settings";

// Reviewed Azure model/version: gpt-6.1-sol-2026-09-29. Keep the selected
// deployment's native context independent of a retained models.dev cache.
// https://learn.microsoft.com/azure/foundry/openai/how-to/reasoning
export function openCodeModelMetadata(
  provider: "openai" | "anthropic" | "deepseek" | undefined,
  modelID: string,
) {
  if (
    (provider ?? "openai") === "openai" &&
    ["gpt-6.1-sol", "gpt-6.1-sol-2026-09-29"].includes(modelID)
  )
    return {
      name: modelID,
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    };
  // A deployment alias is not proof of its underlying model or capabilities.
  return { name: modelID };
}

// Used by both the native access probe and the runtime composition. Absence of
// reasoning identifies a frozen historical configuration, never a new default.
export function openCodeModelConfiguration(input: {
  provider?: "openai" | "anthropic" | "deepseek";
  modelID: string;
  reasoningEffort?: CodingReasoning;
}) {
  const provider = input.provider ?? "openai";
  return {
    package:
      provider === "anthropic"
        ? "@opencode/ai/providers/anthropic"
        : provider === "deepseek"
          ? "@opencode/ai/providers/deepseek"
          : input.reasoningEffort
            ? "@opencode/ai/providers/openai/responses"
            : "@opencode/ai/providers/openai/chat",
    settings:
      provider !== "openai"
        ? {}
        : input.reasoningEffort
          ? {
              reasoningEffort: input.reasoningEffort,
              store: false,
              include: ["reasoning.encrypted_content"],
            }
          : input.modelID === "gpt-5.6-terra"
            ? { reasoningEffort: "none" as const }
            : {},
  };
}
