import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ModelProbeResult } from "../../../../packages/conversation-domain/src/model-connection";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import { createMastraUsage, type MastraUsageSink } from "../usage/mastra";
import { nativeAgentPolicy, nativeStepGuard } from "./execution-policy";
import { modelProviderOptions, nativeModel, type ResolvedModelConnection } from "./native";
import { modelProbeFailure, reportedModelLimits } from "./probe";

const output = z
  .object({ verified: z.literal(true), value: z.literal("factory-connection-ok") })
  .strict();
const emptyLimits = () => ({
  requests: null,
  tokens: null,
  remainingRequests: null,
  remainingTokens: null,
});

// One explicitly authorized probe, at most two model steps. No retries or fallback.
// It proves this request's access/capabilities, not sustained token-per-minute capacity.
export async function probeModel(input: {
  connection: ResolvedModelConnection;
  modelId: string;
  signal: AbortSignal;
  role?: "planning" | "build";
  usageSink?: MastraUsageSink;
  reasoningEffort?: CodingReasoning;
}): Promise<ModelProbeResult> {
  if (input.role === "build") {
    const { probeBuildModel } = await import("./build-probe");
    return probeBuildModel(input);
  }
  let toolCall = false;
  let limits: ModelProbeResult["limits"] = emptyLimits();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  const usage = createMastraUsage(input.usageSink, input.connection.provider ?? "openai", signal);
  try {
    signal.throwIfAborted();
    const probeTool = createTool({
      id: "factory-connection-probe",
      description: "Read the test value required to confirm this model connection.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ value: z.literal("factory-connection-ok") }).strict(),
      execute: async () => {
        signal.throwIfAborted();
        toolCall = true;
        return { value: "factory-connection-ok" as const };
      },
    });
    const agent = new Agent({
      id: "factory-model-probe",
      name: "Factory model connection check",
      model: await nativeModel(input.connection, input.modelId),
      ...nativeAgentPolicy,
      tools: { probe: probeTool },
      instructions:
        "Call probe exactly once. Then return verified:true and its exact value using the output schema. Do nothing else.",
    });
    const mastra = new Mastra({ agents: { probe: agent }, logger: noopLogger });
    const options = modelProviderOptions(input.connection, input.modelId);
    await usage.begin();
    const result = await mastra.getAgent("probe").generate("Check this connection.", {
      abortSignal: signal,
      maxSteps: 2,
      prepareStep: nativeStepGuard({ signal, maxInputBytes: 32 * 1024 }),
      modelSettings: { maxOutputTokens: 128, maxRetries: 0 },
      structuredOutput: { schema: output, jsonPromptInjection: "auto" },
      onStepFinish: (step) => usage.onStepFinish(step),
      ...(options ? { providerOptions: options } : {}),
    });
    signal.throwIfAborted();
    if (result.error) throw result.error;
    for (const step of result.steps) {
      const reported = reportedModelLimits(step.response.headers);
      if (Object.values(reported).some((value) => value !== null)) limits = reported;
    }
    const structuredOutput = output.safeParse(result.object).success;
    await usage.finish();
    return {
      status: toolCall && structuredOutput ? "ready" : "unsupported",
      modelId: input.modelId,
      toolCall,
      structuredOutput,
      limits,
    };
  } catch (cause) {
    await usage.finish(true);
    // Never return SDK errors, request bodies, response bodies, URLs or keys to the client.
    return {
      status: modelProbeFailure(cause, signal),
      modelId: input.modelId,
      toolCall,
      structuredOutput: false,
      limits,
    };
  }
}
