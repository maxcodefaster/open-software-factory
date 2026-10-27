export function bounded(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function readableError(value: unknown) {
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
