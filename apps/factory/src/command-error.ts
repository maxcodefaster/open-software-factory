export class CommandError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "not-found" | "unavailable" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }

  get status() {
    return { invalid: 400, conflict: 409, "not-found": 404, unavailable: 503, forbidden: 403 }[
      this.code
    ];
  }
}

export const unreachableMessage =
  "Factory could not reach the server. Check your connection, then try again.";

/** True when a call failed only because the network or server was briefly unreachable. */
export function isUnreachable(cause: unknown) {
  return cause instanceof Error && cause.message === unreachableMessage;
}

/**
 * Repeats a call while the server is only unreachable. Other failures and an outage that outlasts
 * `limitMs` surface unchanged, so a brief network loss never reaches the person using Factory.
 */
export async function untilReachable<T>(call: () => Promise<T>, limitMs = 60_000, waitMs = 2_000) {
  const started = performance.now();
  for (;;) {
    try {
      return await call();
    } catch (cause) {
      if (!isUnreachable(cause) || performance.now() - started > limitMs) throw cause;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** Replaces transport and runtime error text with a sentence a person can act on. */
export function plainErrorMessage(message: string) {
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message))
    return unreachableMessage;
  if (/server function call failed|^(Type|Reference|Syntax|Range)Error\b/i.test(message))
    return "Factory could not complete that action. Try again.";
  return message;
}
