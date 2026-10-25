import { z } from "zod";
import type { ModelProbeResult } from "../../../../packages/conversation-domain/src/model-connection";

export function reportedModelLimits(
  headers: Headers | Record<string, string> | undefined,
): ModelProbeResult["limits"] {
  const values = new Headers(headers);
  function count(...names: string[]) {
    for (const name of names) {
      const value = values.get(name);
      if (value === null || !/^\d{1,16}$/.test(value)) continue;
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    return null;
  }
  return {
    requests: count("x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"),
    tokens: count("x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"),
    remainingRequests: count(
      "x-ratelimit-remaining-requests",
      "anthropic-ratelimit-requests-remaining",
    ),
    remainingTokens: count("x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"),
  };
}

export function modelProbeFailure(
  cause: unknown,
  signal?: AbortSignal,
): ModelProbeResult["status"] {
  if (signal?.aborted)
    return signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      ? "timeout"
      : "stopped";
  let current = cause;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const parsed = z
      .object({ statusCode: z.number().optional(), status: z.number().optional() })
      .safeParse(current);
    const status = parsed.success ? (parsed.data.statusCode ?? parsed.data.status) : undefined;
    if (status === 401) return "invalid-credentials";
    if (status === 403 || status === 404) return "model-denied";
    if (status === 429) return "rate-limited";
    if (status === 400 || status === 422) return "unsupported";
    current = "cause" in current ? current.cause : undefined;
  }
  return cause instanceof z.ZodError ? "unsupported" : "unavailable";
}

export async function probeModel(
  input: Parameters<typeof import("./probe-engine").probeModel>[0],
): Promise<ModelProbeResult> {
  // The engine retains the existing stopped/timeout result if this check is
  // cancelled while its first import is in progress.
  const { probeModel: probe } = await import("./probe-engine");
  return probe(input);
}
