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

/** Replaces transport and runtime error text with a sentence a person can act on. */
export function plainErrorMessage(message: string) {
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message))
    return "Factory could not reach the server. Check your connection, then try again.";
  if (/server function call failed|^(Type|Reference|Syntax|Range)Error\b/i.test(message))
    return "Factory could not complete that action. Try again.";
  return message;
}
