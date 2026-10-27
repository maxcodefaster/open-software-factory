import { Agent } from "@mastra/core/agent";
import {
  replayAnswers,
  replayTasks,
} from "../../../../packages/conversation-domain/src/learning-comparison";
import { nativeAgentPolicy, nativeStepGuard } from "../models/execution-policy";
import { nativeModel, modelProviderOptions } from "../models/native";
import { createMastraUsage } from "../usage/mastra";
import { replayInstructions, type ReplayInput } from "./replay";
export async function replayPlanningWithModel(input: ReplayInput) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(90_000)]);
  const usage = createMastraUsage(input.usage, input.connection.provider ?? "openai", signal);
  const agent = new Agent({
    id: "factory-planning-text-replay",
    name: "Planning text replay",
    model: await nativeModel(input.connection, input.modelId),
    ...nativeAgentPolicy,
    instructions: `${replayInstructions}\n\nSkill instructions\n${input.instructions}`,
  });
  await input.authorize();
  await usage.begin();
  let failed = true;
  try {
    const providerOptions = modelProviderOptions(input.connection, input.modelId);
    const response = await agent.generate(JSON.stringify({ tasks: replayTasks(input.cases) }), {
      abortSignal: signal,
      maxSteps: 1,
      prepareStep: nativeStepGuard({
        signal,
        authorize: input.authorize,
        maxInputBytes: 192 * 1024,
      }),
      modelSettings: { maxRetries: 0, maxOutputTokens: 4_500 },
      ...(providerOptions ? { providerOptions } : {}),
      structuredOutput: { schema: replayAnswers, jsonPromptInjection: "auto" },
      onStepFinish: (step) => usage.onStepFinish(step),
    });
    signal.throwIfAborted();
    if (response.error) throw response.error;
    const result = replayAnswers.parse(response.object);
    await input.authorize();
    failed = false;
    return result;
  } finally {
    await usage.finish(failed);
  }
}
