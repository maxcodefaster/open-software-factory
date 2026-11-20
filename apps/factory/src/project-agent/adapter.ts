import { z } from "zod";
import {
  type ConversationMode,
  projectAgentAnswerOutput,
  projectAgentOutput,
} from "../../../../packages/conversation-domain/src/conversation";

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
