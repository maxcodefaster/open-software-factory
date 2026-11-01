import type { ProcessLLMRequestArgs, Processor } from "@mastra/core/processors";
import { codeReadInput } from "../knowledge/code-read";
import { nativeInputSize, nativeStepGuard } from "../models/execution-policy";

type Prompt = ProcessLLMRequestArgs["prompt"];
const maximumInputBytes = 256 * 1024;
const maximumMediaBytes = 16 * 1024 * 1024;

/** Project only older immutable reads; never change retained messages or tool execution. */
export function compactResearchPrompt(prompt: Prompt): Prompt {
  const size = (messages: Prompt) =>
    nativeInputSize({ messages, systemMessages: [], maxMediaBytes: maximumMediaBytes }).textBytes;
  let bytes = size(prompt);
  if (bytes <= maximumInputBytes) return prompt;
  const calls = new Map<string, { toolName: string; input: unknown }>();
  let latestCalls = new Set<string>();
  for (const message of prompt) {
    if (message.role !== "assistant") continue;
    const stepCalls = message.content.filter((part) => part.type === "tool-call");
    if (!stepCalls.length) continue;
    latestCalls = new Set(stepCalls.map((part) => part.toolCallId));
    for (const part of stepCalls)
      calls.set(part.toolCallId, { toolName: part.toolName, input: part.input });
  }
  const projected = [...prompt];
  for (let messageIndex = 0; messageIndex < prompt.length; messageIndex++) {
    const message = prompt[messageIndex];
    if (message?.role !== "tool") continue;
    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      const part = message.content[partIndex];
      if (part?.toolName !== "readCode" || latestCalls.has(part.toolCallId)) continue;
      const call = calls.get(part.toolCallId);
      if (call?.toolName !== part.toolName || part.output.type !== "json") continue;
      const target = codeReadInput.safeParse(call.input);
      if (!target.success) continue;
      const value = part.output.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (typeof value["body"] !== "string") continue;
      const output = {
        ...value,
        body: "[Earlier immutable source text omitted from this model request. The complete result remains cached for this turn. Call readCode with the same arguments to inspect it again; this marker is not source evidence.]",
        sourceTextOmittedFromPrompt: true,
        reread: { tool: part.toolName, arguments: target.data },
      };
      const saved =
        Buffer.byteLength(JSON.stringify(value)) - Buffer.byteLength(JSON.stringify(output));
      if (saved <= 0) continue;
      const previous = projected[messageIndex];
      if (previous?.role !== "tool") continue;
      const content = [...previous.content];
      content[partIndex] = { ...part, output: { type: "json", value: output } };
      projected[messageIndex] = { ...previous, content };
      bytes -= saved;
      if (bytes <= maximumInputBytes) return projected;
    }
  }
  // The unchanged guard rejects an oversized core, latest batch or other tool
  // output. Never clip authored decisions, images, mutations or unknown results.
  return projected;
}

export function createResearchContextProcessor(input: {
  signal: AbortSignal;
  authorize?: (() => Promise<void>) | undefined;
}) {
  const guard = nativeStepGuard({
    ...input,
    maxInputBytes: maximumInputBytes,
    maxMediaBytes: maximumMediaBytes,
  });
  return {
    id: "factory-project-research-context",
    async processLLMRequest({ prompt }) {
      const projected = compactResearchPrompt(prompt);
      await guard({ messages: projected, systemMessages: [] });
      return { prompt: projected };
    },
  } satisfies Processor;
}
