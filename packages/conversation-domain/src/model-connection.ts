import { z } from "zod";
import { codingReasoningInput, modelIdInput } from "./model-settings";

export const modelProvider = z.enum(["openai", "anthropic", "deepseek"]);
export type ModelProvider = z.output<typeof modelProvider>;

export const modelConnectionMetadata = z
  .object({
    provider: modelProvider,
    endpoint: z.string().max(500).nullable(),
  })
  .strict();
export type ModelConnectionMetadata = z.output<typeof modelConnectionMetadata>;

export const modelConnectionWrite = modelConnectionMetadata
  .extend({
    commandID: z.uuid(),
    connectionID: z.uuid(),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((key) => !/[\r\n]/.test(key) && !key.includes(String.fromCharCode(0))),
  })
  .strict();
export type ModelConnectionWrite = z.output<typeof modelConnectionWrite>;

export const modelProbeResult = z
  .object({
    status: z.enum([
      "ready",
      "invalid-credentials",
      "model-denied",
      "rate-limited",
      "unsupported",
      "unavailable",
      "stopped",
      "timeout",
      "superseded",
    ]),
    modelId: modelIdInput,
    toolCall: z.boolean(),
    structuredOutput: z.boolean(),
    limits: z
      .object({
        requests: z.number().int().nonnegative().nullable(),
        tokens: z.number().int().nonnegative().nullable(),
        remainingRequests: z.number().int().nonnegative().nullable(),
        remainingTokens: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export type ModelProbeResult = z.output<typeof modelProbeResult>;

export const modelConnectionView = modelConnectionMetadata
  .extend({
    connectionID: z.uuid(),
    version: z.number().int().nonnegative(),
    configured: z.boolean(),
    pendingCommandID: z.uuid().nullable(),
  })
  .strict();
export type ModelConnectionView = z.output<typeof modelConnectionView>;

export const modelConnectionReference = z
  .object({ connectionID: z.uuid(), version: z.number().int().positive() })
  .strict();
export type ModelConnectionReference = z.output<typeof modelConnectionReference>;
export const modelRoleConnectionInput = modelConnectionReference
  .extend({
    commandID: z.uuid(),
    settingsVersion: z.number().int().nonnegative(),
    role: z.enum(["planning", "build"]),
    modelId: modelIdInput,
    reasoningEffort: codingReasoningInput.optional(),
    confirmInference: z.literal(true),
  })
  .strict()
  .refine((input) => input.role === "build" || input.reasoningEffort === undefined, {
    message: "Reasoning selection is only available for Coding",
    path: ["reasoningEffort"],
  });

export const modelRoleConnectionView = z
  .object({
    role: z.enum(["planning", "build"]),
    active: modelConnectionReference.extend({ modelId: modelIdInput }).nullable(),
    check: z
      .object({
        commandID: z.uuid(),
        state: z.enum(["probing", "finished", "uncertain"]),
        result: modelProbeResult.nullable(),
      })
      .nullable(),
  })
  .strict();
