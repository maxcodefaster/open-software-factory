const secretPatterns: Array<[RegExp, string]> = [
  [/(factory-grant|token|secret|password|signature|api[-_]?key)=([^&\s"']+)/gi, "$1=[redacted]"],
  [/(authorization:\s*)(bearer|basic)\s+\S+/gi, "$1$2 [redacted]"],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[redacted]@"],
];

/** A bounded, credential-free description of a failure that keeps its cause chain. */
export function describeFailure(cause: unknown, depth = 0): string {
  if (depth > 3) return "…";
  let text: string;
  if (cause instanceof Error) {
    const frames = (cause.stack ?? "")
      .split("\n")
      .filter((line) => line.trimStart().startsWith("at "))
      .slice(0, 4)
      .join("\n");
    text = `${cause.name}: ${cause.message}${frames ? `\n${frames}` : ""}`;
    if (cause.cause !== undefined) text += `\ncaused by ${describeFailure(cause.cause, depth + 1)}`;
  } else text = typeof cause === "string" ? cause : (JSON.stringify(cause) ?? String(cause));
  for (const [pattern, replacement] of secretPatterns) text = text.replace(pattern, replacement);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export function logFailure(context: string, cause: unknown) {
  console.error(`[factory] ${context}: ${describeFailure(cause)}`);
}

/** Replacement for `.catch(() => {})` on work that must not throw but must stay visible. */
export function reportFailure(context: string) {
  return (cause: unknown) => logFailure(context, cause);
}
