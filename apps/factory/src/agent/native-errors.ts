import { plainErrorMessage, plainFailureMessage, unreachableMessage } from "../command-error";

export function bounded(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function readableError(value: unknown, context?: "tool" | "browser") {
  const raw = rawError(value);
  const failure = plainFailureMessage(raw);
  if (!context || raw.startsWith("Factory Coding allowance paused subsequent inference."))
    return failure;
  const plain = plainErrorMessage(raw);
  // Tool transport/status codes do not establish a model-provider failure. Keep
  // replacements fixed so bypassing provider wording cannot expose credentials.
  if (
    failure !== plain ||
    plain === unreachableMessage ||
    (plain === raw &&
      /\bmcp\b.*(?:connect|transport)|\bconnection (?:closed|failed|failure)\b|\bnot connected\b/i.test(
        raw,
      ))
  ) {
    return context === "browser"
      ? "Factory could not confirm the browser tool result. Check the browser connection and inspect the App before another UI action. Do not replay an unconfirmed UI mutation."
      : "Factory could not confirm the tool result. Check the tool connection and its current state before another action.";
  }
  return plain;
}

function rawError(value: unknown) {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    if ("message" in value && typeof value.message === "string") return value.message;
    if ("data" in value && value.data && typeof value.data === "object") {
      if ("message" in value.data && typeof value.data.message === "string") {
        return value.data.message;
      }
    }
  }
  return typeof value === "string"
    ? value
    : "The agent stopped unexpectedly. Retained work is kept. Retry to continue.";
}
