import { ModelExecutionBoundError } from "../models/execution-policy";

type Headers = Record<string, unknown>;

/**
 * A 429 is a definite refusal: the provider charged nothing and started no inference. Returns the
 * requested wait in milliseconds (undefined inside the result when no header names one), or
 * undefined when the failure is anything else, including a 5xx or lost connection.
 */
export function rateLimitRefusal(
  cause: unknown,
  now = Date.now(),
): { waitMs: number | undefined } | undefined {
  let current = cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    const status = record["statusCode"] ?? record["status"];
    if (status === 429) {
      const headers = (record["responseHeaders"] ?? record["headers"]) as Headers | undefined;
      return { waitMs: headerWait(headers, now) };
    }
    current = record["cause"];
  }
  return undefined;
}

function headerWait(headers: Headers | undefined, now: number) {
  if (!headers || typeof headers !== "object") return undefined;
  const read = (name: string) => {
    for (const [key, value] of Object.entries(headers))
      if (key.toLowerCase() === name && (typeof value === "string" || typeof value === "number"))
        return String(value).trim();
    return undefined;
  };
  const milliseconds = read("retry-after-ms");
  if (milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds)) return Math.ceil(Number(milliseconds));
  const after = read("retry-after");
  if (!after) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(after)) return Math.ceil(Number(after) * 1000);
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export type RateLimitState = { until: number };

export type RetryOptions = {
  signal: AbortSignal;
  /** Shared by every agent of one generation, so concurrent steps pause together. */
  state: RateLimitState;
  requests?: { remaining: number } | undefined;
  authorize?: (() => Promise<void>) | undefined;
  retries?: number;
  /** A longer requested wait is not retried; the 429 fails the step as before. */
  maximumWaitMs?: number;
  now?: () => number;
};

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

type Callable = (options: unknown) => Promise<unknown>;

/**
 * Wraps an AI SDK language model so a 429 waits for Retry-After and repeats the same provider
 * call instead of failing the whole agent run. Only a 429 that names its wait is repeated. Every repeat consumes the shared request budget,
 * is authorized again and stops on abort. Other failures are never retried.
 */
export function retryRateLimited<T>(model: T, options: RetryOptions): T {
  if (!model || typeof model !== "object") return model;
  const source = model as Record<string, unknown>;
  const methods = ["doStream", "doGenerate"].filter((name) => typeof source[name] === "function");
  if (!methods.length) return model;
  const retries = options.retries ?? 4;
  const maximumWait = options.maximumWaitMs ?? 60_000;
  const clock = options.now ?? Date.now;
  const wrapped = Object.create(model as object) as T;
  for (const name of methods) {
    const original = source[name] as Callable;
    Object.defineProperty(wrapped, name, {
      configurable: true,
      writable: true,
      value: async (call: unknown) => {
        for (let attempt = 0; ; attempt++) {
          for (
            let wait = options.state.until - clock();
            wait > 0;
            wait = options.state.until - clock()
          )
            await sleep(wait, options.signal);
          options.signal.throwIfAborted();
          try {
            return await original.call(model, call);
          } catch (cause) {
            const refusal = rateLimitRefusal(cause, clock());
            if (!refusal || attempt >= retries) throw cause;
            // Without a stated wait the provider gave no reason to expect a repeat to succeed.
            const wait = refusal.waitMs;
            if (
              wait === undefined ||
              wait > maximumWait ||
              (options.requests && options.requests.remaining <= 0)
            )
              throw cause;
            options.state.until = Math.max(options.state.until, clock() + wait);
            await sleep(Math.max(0, options.state.until - clock()), options.signal);
            await options.authorize?.();
            if (options.requests) {
              if (options.requests.remaining <= 0) throw new ModelExecutionBoundError("requests");
              options.requests.remaining--;
            }
          }
        }
      },
    });
  }
  return wrapped;
}
