import { ai, ToolChoice, tool } from "@opencode/ai";
import { model as anthropicModel } from "@opencode/ai/providers/anthropic";
import { model as deepseekModel } from "@opencode/ai/providers/deepseek";
import { model as openaiModel } from "@opencode/ai/providers/openai/responses";
import { z } from "zod";
import type { ModelProbeResult } from "#conversation-domain/model-connection";
import { codingReasoningInput } from "#conversation-domain/model-settings";
import { unknownCounters, usageCounters } from "#conversation-domain/usage";
import { openCodeModelConfiguration } from "#runtime-kubernetes/opencode-model";
import type { ModelProbeInput } from "./probe-contracts";
import { modelProbeFailure, reportedModelLimits } from "./probe-result";

const probeOutput = z.object({
  verified: z.literal(true),
  value: z.literal("factory-connection-ok"),
});

// The exact native provider modules used by OpenCode 2, without starting compute
// or copying the provider protocol. One inference, no retries and no fallback.
export async function probeBuildModel(
  input: Omit<ModelProbeInput, "role">,
): Promise<ModelProbeResult> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]);
  let limits = reportedModelLimits(undefined);
  let toolCall = false;
  let admitted = false;
  try {
    signal.throwIfAborted();
    const settings = {
      apiKey: input.connection.apiKey,
      ...(input.connection.baseURL ? { baseURL: input.connection.baseURL } : {}),
      ...openCodeModelConfiguration({
        ...input.connection,
        modelID: input.modelId,
        reasoningEffort: codingReasoningInput.parse(input.reasoningEffort ?? "medium"),
      }).settings,
    };
    const model =
      input.connection.provider === "anthropic"
        ? anthropicModel(input.modelId, settings)
        : input.connection.provider === "deepseek"
          ? deepseekModel(input.modelId, settings)
          : openaiModel(input.modelId, settings);
    const probeTool = tool({
      name: "factory_connection_probe",
      description: "Confirm native model access by returning this exact structured value.",
      input: z.toJSONSchema(probeOutput),
    });
    const nativeFetch = globalThis.fetch;
    await input.usageSink?.begin();
    admitted = true;
    const response = await ai.generate(
      {
        model,
        system:
          "Call factory_connection_probe once with verified:true and value:factory-connection-ok. Do nothing else.",
        prompt: "Check native Build transport.",
        maxTokens: 4_096,
        tools: [probeTool],
        toolChoice: ToolChoice.named("factory_connection_probe"),
        // Official per-request fetch override keeps the native executor's status,
        // transport and cancellation handling. Observe headers without reading,
        // cloning or replacing the body, including on definite provider refusals.
        fetch: Object.assign(
          async (request: string | URL | Request, init?: RequestInit) => {
            const response = await nativeFetch(request, init);
            limits = reportedModelLimits(response.headers);
            return response;
          },
          { preconnect: nativeFetch.preconnect },
        ),
      },
      { signal },
    );
    const calls = response.toolCalls.filter((call) => call.name === "factory_connection_probe");
    const native = response.usage;
    const counters = native
      ? usageCounters.parse({
          input: native.nonCachedInputTokens ?? null,
          output: native.outputTokens ?? null,
          cacheRead: native.cacheReadInputTokens ?? null,
          cacheWrite: native.cacheWriteInputTokens ?? null,
          reasoning: native.reasoningTokens ?? null,
        })
      : unknownCounters();
    await input.usageSink?.record({
      eventID: "step:1",
      source: "step",
      outcome: "completed",
      counters,
      occurredAt: new Date().toISOString(),
    });
    await input.usageSink?.settle("completed");
    toolCall = calls.length === 1;
    const structuredOutput = toolCall && probeOutput.safeParse(calls[0]?.input).success;
    return {
      status: structuredOutput ? "ready" : "unsupported",
      modelId: input.modelId,
      toolCall,
      structuredOutput,
      limits,
    };
  } catch (cause) {
    if (admitted) {
      const outcome = signal.aborted ? "interrupted" : "failed";
      await input.usageSink?.record({
        eventID: "unobserved",
        source: "unobserved",
        outcome,
        counters: unknownCounters(),
        occurredAt: new Date().toISOString(),
      });
      await input.usageSink?.settle(outcome);
    }
    return {
      // The Promise API preserves AIError.status and its native cause.
      status: modelProbeFailure(cause, signal),
      modelId: input.modelId,
      toolCall,
      structuredOutput: false,
      limits,
    };
  }
}
