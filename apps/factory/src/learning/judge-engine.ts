import { Agent } from "@mastra/core/agent";
import { learningResult } from "../../../../packages/conversation-domain/src/learning";
import { nativeAgentPolicy, nativeStepGuard } from "../models/execution-policy";
import { modelProviderOptions, nativeModel } from "../models/native";
import { createMastraUsage } from "../usage/mastra";
import { workReviewInstructions, type WorkReviewInput } from "./judge";

export async function reviewWorkWithModel(input: WorkReviewInput) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(90_000)]);
  const usage = createMastraUsage(input.usage, input.connection.provider ?? "openai", signal);
  const agent = new Agent({
    id: "factory-work-review",
    name: "Work review",
    model: await nativeModel(input.connection, input.modelId),
    ...nativeAgentPolicy,
    instructions: workReviewInstructions,
  });
  await input.authorize();
  await usage.begin();
  let failed = true;
  try {
    const providerOptions = modelProviderOptions(input.connection, input.modelId);
    const response = await agent.generate(JSON.stringify({ cases: input.cases }), {
      abortSignal: signal,
      maxSteps: 1,
      prepareStep: nativeStepGuard({
        signal,
        authorize: input.authorize,
        maxInputBytes: 192 * 1024,
      }),
      modelSettings: { maxRetries: 0, maxOutputTokens: 6_000 },
      ...(providerOptions ? { providerOptions } : {}),
      structuredOutput: { schema: learningResult, jsonPromptInjection: "auto" },
      onStepFinish: (step) => usage.onStepFinish(step),
    });
    signal.throwIfAborted();
    if (response.error) throw response.error;
    const result = learningResult.parse(response.object);
    await input.authorize();
    failed = false;
    return result;
  } finally {
    await usage.finish(failed);
  }
}
