import type { CodingReasoning } from "../../conversation-domain/src/model-settings";

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
