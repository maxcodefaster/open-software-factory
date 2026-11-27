import { z } from "zod";
import {
  type ConversationMode,
  projectAgentAnswerOutput,
  projectAgentOutput,
} from "#conversation-domain/conversation";

export const projectAgentStructuredOutput = z.object({ output: projectAgentOutput }).strict();

export function projectAgentStructuredOutputFor(mode: ConversationMode) {
  return mode === "investigate"
    ? projectAgentStructuredOutput.extend({ output: projectAgentAnswerOutput })
    : projectAgentStructuredOutput;
}

export async function generateProjectResponse(
  input: Parameters<typeof import("./engine").generateProjectResponse>[0],
) {
  input.signal.throwIfAborted();
  const { generateProjectResponse: generate } = await import("./engine");
  input.signal.throwIfAborted();
  return generate(input);
}
