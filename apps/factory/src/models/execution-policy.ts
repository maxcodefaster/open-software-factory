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

export function nativeStepGuard(input: {
  signal: AbortSignal;
  maxInputBytes: number;
  requests?: { remaining: number };
  authorize?: (() => Promise<void>) | undefined;
}) {
  return async (step: { messages: readonly unknown[]; systemMessages: readonly unknown[] }) => {
    input.signal.throwIfAborted();
    await input.authorize?.();
    if (
      Buffer.byteLength(JSON.stringify([step.systemMessages, step.messages])) > input.maxInputBytes
    )
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
