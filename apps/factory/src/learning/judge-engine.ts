import { Agent } from "@mastra/core/agent";
import { nativeAgentPolicy, nativeStepGuard } from "../models/execution-policy";
import { modelProviderOptions, nativeModel } from "../models/native";
import { createMastraUsage } from "../usage/model-api";
import { type WorkReviewInput, workReviewInstructions } from "./judge-contract";
import { createWorkReviewOutput } from "./judge-output";

export async function reviewWorkWithModel(input: WorkReviewInput) {
  const output = createWorkReviewOutput(input.cases);
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
    const response = await agent.generate(JSON.stringify({ cases: output.cases }), {
      abortSignal: signal,
      maxSteps: 1,
      prepareStep: nativeStepGuard({
        signal,
        authorize: input.authorize,
        maxInputBytes: 192 * 1024,
      }),
      modelSettings: { maxRetries: 0, maxOutputTokens: 6_000 },
      ...(providerOptions ? { providerOptions } : {}),
      structuredOutput: { schema: output.schema, jsonPromptInjection: "auto" },
      onStepFinish: (step) => usage.onStepFinish(step),
    });
    signal.throwIfAborted();
    if (response.error) throw response.error;
    const result = output.parse(response.object);
    await input.authorize();
    failed = false;
    return result;
  } finally {
    await usage.finish(failed);
  }
}
