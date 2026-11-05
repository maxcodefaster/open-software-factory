export function bounded(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

const rateLimited =
  /rate_limit_exceeded|exceeded (?:the )?token rate limit|too many requests|\b429\b/i;

export function readableError(value: unknown) {
  const message = rawError(value);
  return rateLimited.test(message)
    ? "The model provider is limiting requests right now. Wait a minute, then retry. Retained work is kept."
    : message;
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
  return typeof value === "string" ? value : "OpenCode run failed";
}
