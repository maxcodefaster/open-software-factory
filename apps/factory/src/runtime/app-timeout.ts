import { json } from "../http";

export function appTimeoutResponse(request: Request, cause: unknown) {
  if (
    !(cause instanceof Error) ||
    cause.message !== "Runtime request timed out" ||
    !/^\/runtime\/[0-9a-f-]{36}\/(?:app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)(?:\/|$)/.test(
      new URL(request.url).pathname,
    )
  )
    return undefined;
  const readOnly = request.method === "GET" || request.method === "HEAD";
  return json(
    {
      error: readOnly
        ? "The App response timed out. Check runtime status and try again."
        : "The App did not confirm whether this change finished. Check the App before submitting it again.",
    },
    504,
    { "cache-control": "no-store" },
  );
}
