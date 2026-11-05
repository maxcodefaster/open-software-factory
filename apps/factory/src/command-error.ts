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

export const genericFailure = "Factory could not complete that action. Try again.";
export const sessionExpiredMessage =
  "Your session expired. Reload the page and sign in again; your drafts are retained.";

// Provider and network failures arrive as codes. Only stored failure text passes through these
// rules, never a message that quotes a title or other text a person wrote.
const providerRules: readonly (readonly [RegExp, string])[] = [
  [
    /rate_limit_exceeded|exceeded (?:the )?token rate limit|too many requests|\b429\b/i,
    "The model provider is limiting requests right now. Wait a minute, then retry. Retained work is kept.",
  ],
  [
    /invalid[_ ]api[_ ]key|incorrect api key|authentication[_ ]error|^unauthorized|(?:^|\b(?:http|status|code|error)[\s:=]*)401\b/i,
    "The model provider rejected Factory's credentials. Ask a System Manager to check the model connection, then retry. Retained work is kept.",
  ],
  [
    /insufficient[_ ]quota|exceeded your current quota|credit balance is too low/i,
    "The model provider reports that the account has no quota left. Ask a System Manager to check the provider account, then retry. Retained work is kept.",
  ],
  [
    /context[_ ]length|maximum context|prompt is too long|too many tokens/i,
    "This conversation is too long for the model. Start a new conversation or shorten the request. Retained work is kept.",
  ],
  [
    /overloaded|service unavailable|internal server error|server_error|(?:^|\b(?:http|status|code|error)[\s:=]*)(?:500|502|503|504|529)\b/i,
    "The model provider is temporarily unavailable. Wait a minute, then retry. Retained work is kept.",
  ],
  [
    /econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|request timed out|connection timed out/i,
    "Factory lost its connection to the model provider. Wait a minute, then retry. Retained work is kept.",
  ],
  [
    /^Factory Coding allowance paused subsequent inference\./,
    "The Coding allowance is used up. Your code is kept. Resume after the allowance resets or is raised.",
  ],
];

// Messages written for the server's own bookkeeping. Each rule names the situation in words a
// person can act on, so identities, commands and changed authority never show.
const plainRules: readonly (readonly [RegExp, string])[] = [
  [/server function call failed|^request failed with \d+$/i, genericFailure],
  [
    /\b(identity|command)\b.*\b(reused|already used|different input|changed input|belongs to (another|different)|changed|invalid)\b|\baction key already\b|\b(changed input|different input|changed target|changed its original)\b|\bbelongs to (different|another) (input|work|document|request)\b/i,
    "This request no longer matches what was saved. Reload and try again.",
  ],
  [
    /\b(authority|ownership)\b.*\b(changed|expired|expiring|revoked)\b|\bno longer owns\b|\blost (execution )?ownership\b|\blease expired\b/i,
    "The work changed while this was running. Check its current status, then try again.",
  ],
  [
    /namespace collision/i,
    "Two connected tools have the same name. Disable one of them in Settings.",
  ],
  [/^(Type|Reference|Syntax|Range)Error\b/i, genericFailure],
];

/** Replaces transport, runtime and bookkeeping error text with a sentence a person can act on. */
export function plainErrorMessage(message: string) {
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message))
    return unreachableMessage;
  for (const [pattern, replacement] of plainRules) if (pattern.test(message)) return replacement;
  return message.replace(/\bRuntime Attempt\b/g, "Sandbox");
}

/** Plain wording for a stored failure, which can also carry provider codes. */
export function plainFailureMessage(message: string) {
  for (const [pattern, replacement] of providerRules) if (pattern.test(message)) return replacement;
  return plainErrorMessage(message);
}
