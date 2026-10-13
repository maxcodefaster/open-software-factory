import { LLM, LLMClient, Tool, ToolChoice } from "@opencode/ai";
import { model as anthropicModel } from "@opencode/ai/providers/anthropic";
import { model as deepseekModel } from "@opencode/ai/providers/deepseek";
import { model as openaiModel } from "@opencode/ai/providers/openai/chat";
import { RequestExecutor } from "@opencode/ai/route";
import { Effect, Layer, Schema } from "effect";
import type { ModelProbeResult } from "../../../../packages/conversation-domain/src/model-connection";
import type { ResolvedModelConnection } from "./native";
import { modelProbeFailure, reportedModelLimits } from "./probe";
import type { MastraUsageSink } from "../usage/mastra";
import { unknownCounters, usageCounters } from "../../../../packages/conversation-domain/src/usage";

// The exact native provider modules used by OpenCode 2, without starting compute
// or copying the provider protocol. One inference, no retries and no fallback.
export async function probeBuildModel(input: {
  connection: ResolvedModelConnection;
  modelId: string;
  signal: AbortSignal;
  usageSink?: MastraUsageSink;
}): Promise<ModelProbeResult> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  let limits = reportedModelLimits(undefined);
  let toolCall = false;
  let admitted = false;
  try {
    signal.throwIfAborted();
    const settings = {
      apiKey: input.connection.apiKey,
      ...(input.connection.baseURL ? { baseURL: input.connection.baseURL } : {}),
      ...(input.modelId === "gpt-5.6-terra" && (input.connection.provider ?? "openai") === "openai"
        ? { reasoningEffort: "none" as const }
        : {}),
    };
    const model =
      input.connection.provider === "anthropic"
        ? anthropicModel(input.modelId, settings)
        : input.connection.provider === "deepseek"
          ? deepseekModel(input.modelId, settings)
          : openaiModel(input.modelId, settings);
    const tool = Tool.make({
      description: "Confirm native model access by returning this exact structured value.",
      parameters: Schema.Struct({
        verified: Schema.Literal(true),
        value: Schema.Literal("factory-connection-ok"),
      }),
      success: Schema.Unknown,
    });
    const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer));
    await input.usageSink?.begin();
    admitted = true;
    const response = await Effect.runPromise(
      LLM.generate(
        LLM.request({
          model,
          system:
            "Call factory_connection_probe once with verified:true and value:factory-connection-ok. Do nothing else.",
          prompt: "Check native Build transport.",
          generation: { maxTokens: 128 },
          tools: Tool.toDefinitions({ factory_connection_probe: tool }),
          toolChoice: ToolChoice.named("factory_connection_probe"),
        }),
        {
          http: (request, execute) =>
            execute(request).pipe(
              Effect.tap((response) =>
                Effect.sync(() => {
                  limits = reportedModelLimits(response.headers);
                }),
              ),
            ),
        },
      ).pipe(
        Effect.catch((cause) => Effect.fail(cause.cause.http ?? cause)),
        Effect.provide(layer),
      ),
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
    const structuredOutput = toolCall && Schema.is(tool.parameters)(calls[0]?.input);
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
    const native = cause && typeof cause === "object" && "cause" in cause ? cause.cause : cause;
    const http = native && typeof native === "object" && "http" in native ? native.http : undefined;
    return {
      status: modelProbeFailure(http ?? cause, signal),
      modelId: input.modelId,
      toolCall,
      structuredOutput: false,
      limits,
    };
  }
}
