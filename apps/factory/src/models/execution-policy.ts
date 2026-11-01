// These are native Mastra controls, shared by our four inference adapters.
// A lost request is never retried by the SDK or an error processor.
export const nativeAgentPolicy = {
  maxRetries: 0,
  errorProcessorDefaults: false,
  maxProcessorRetries: 0,
} as const;

export class ModelExecutionBoundError extends Error {
  constructor(bound: "input" | "requests") {
    super(`Model ${bound} bound reached. No additional provider request was started.`);
    this.name = "ModelExecutionBoundError";
  }
}

export function modelExecutionBound(cause: unknown): "input" | "requests" | undefined {
  let current = cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    if (record["name"] === "ModelExecutionBoundError" && typeof record["message"] === "string") {
      if (record["message"].startsWith("Model input bound reached.")) return "input";
      if (record["message"].startsWith("Model requests bound reached.")) return "requests";
    }
    current = record["cause"];
  }
  return undefined;
}

export function nativeInputSize(input: {
  messages: readonly unknown[];
  systemMessages: readonly unknown[];
  maxMediaBytes?: number;
}) {
  let mediaBytes = 0;
  const serialized = JSON.stringify(
    [input.systemMessages, input.messages],
    (_key, value: unknown) => {
      if (!value || typeof value !== "object" || !input.maxMediaBytes) return value;
      const part = value as Record<string, unknown>;
      if (
        part["type"] !== "image-data" &&
        part["type"] !== "image" &&
        !(
          part["type"] === "file" &&
          typeof part["mediaType"] === "string" &&
          part["mediaType"].startsWith("image/")
        )
      )
        return value;
      const media = part["data"] ?? part["image"];
      if (
        typeof media === "string" &&
        /^(?:data:image\/[a-z+.-]+;base64,)?[A-Za-z0-9+/=\r\n]+$/.test(media)
      ) {
        mediaBytes += Math.ceil((media.replace(/^data:[^,]+,/, "").length * 3) / 4);
        return {
          ...part,
          ...(part["data"] ? { data: "[bounded image]" } : { image: "[bounded image]" }),
        };
      }
      if (media instanceof Uint8Array) {
        mediaBytes += media.byteLength;
        return {
          ...part,
          ...(part["data"] ? { data: "[bounded image]" } : { image: "[bounded image]" }),
        };
      }
      return value;
    },
  );
  return { textBytes: Buffer.byteLength(serialized), mediaBytes };
}

export function nativeStepGuard(input: {
  signal: AbortSignal;
  maxInputBytes: number;
  maxMediaBytes?: number;
  requests?: { remaining: number };
  authorize?: (() => Promise<void>) | undefined;
}) {
  return async (step: {
    messages: readonly unknown[];
    systemMessages: readonly unknown[];
    messageList?: ProcessInputStepArgs["messageList"];
  }) => {
    input.signal.throwIfAborted();
    await input.authorize?.();
    // Stored messages repeat text in content.parts and content.content.
    // Count the provider projection once, or the already-projected prompt.
    const size = nativeInputSize({
      messages: step.messageList?.get.all.aiV5.model() ?? step.messages,
      systemMessages: step.systemMessages,
      ...(input.maxMediaBytes ? { maxMediaBytes: input.maxMediaBytes } : {}),
    });
    if (size.textBytes > input.maxInputBytes || size.mediaBytes > (input.maxMediaBytes ?? 0))
      throw new ModelExecutionBoundError("input");
    if (input.requests) {
      if (input.requests.remaining <= 0) throw new ModelExecutionBoundError("requests");
      input.requests.remaining--;
    }
  };
}

// A definite provider refusal proves no useful result was accepted. A 5xx,
// lost connection or timeout may have consumed inference and stays uncertain.
export function knownModelRejection(cause: unknown) {
  let current = cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    // Native workflows serialize errors across step boundaries, preserving the
    // name/cause but not our class prototype.
    if (record["name"] === "ModelExecutionBoundError") return true;
    const status = record["statusCode"] ?? record["status"];
    if (typeof status === "number" && [400, 401, 403, 404, 413, 422, 429].includes(status))
      return true;
    current = record["cause"];
  }
  return false;
}

import type { ProcessInputStepArgs } from "@mastra/core/processors";
