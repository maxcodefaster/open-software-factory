import { z } from "zod";
import {
  type ConversationMode,
  projectAgentAnswerOutput,
  projectAgentOutput,
} from "../../../../packages/conversation-domain/src/conversation";
import { CommandError } from "../command-error";
import type { ResolvedModelConnection } from "../models/native";

export const projectAgentStructuredOutput = z.object({ output: projectAgentOutput }).strict();

export function projectAgentStructuredOutputFor(mode: ConversationMode) {
  return mode === "investigate"
    ? projectAgentStructuredOutput.extend({ output: projectAgentAnswerOutput })
    : projectAgentStructuredOutput;
}

export function projectModelConnection(
  _role: "planning" | "knowledge" = "planning",
): ResolvedModelConnection {
  const baseURL =
    process.env["FACTORY_PLANNING_MODEL_BASE_URL"] || process.env["FACTORY_MODEL_BASE_URL"];
  const apiKey =
    process.env["FACTORY_PLANNING_MODEL_API_KEY"] || process.env["FACTORY_MODEL_API_KEY"];
  if (!baseURL || !apiKey) {
    throw new CommandError(
      "unavailable",
      "The Project Agent model is not configured. Configure the Factory model relay before continuing.",
    );
  }
  return { baseURL: baseURL.replace(/\/$/, ""), apiKey };
}

export async function generateProjectResponse(
  input: Parameters<typeof import("./engine").generateProjectResponse>[0],
) {
  input.signal.throwIfAborted();
  const { generateProjectResponse: generate } = await import("./engine");
  input.signal.throwIfAborted();
  return generate(input);
}
