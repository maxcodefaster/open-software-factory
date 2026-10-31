import { json } from "../http";

export function appRequestFailureResponse(request: Request, cause: unknown) {
  if (
    !(cause instanceof Error) ||
    !["Runtime request timed out", "channel request failed"].includes(cause.message) ||
    !/^\/runtime\/[0-9a-f-]{36}\/(?:app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)(?:\/|$)/.test(
      new URL(request.url).pathname,
    )
  )
    return undefined;
  const timedOut = cause.message === "Runtime request timed out";
  const readOnly = request.method === "GET" || request.method === "HEAD";
  return json(
    {
      error: readOnly
        ? timedOut
          ? "The App response timed out. Check runtime status and try again."
          : "The App could not be reached. Check runtime status before trying again."
        : "The App did not confirm whether this change finished. Check the App before submitting it again.",
    },
    timedOut ? 504 : 503,
    { "cache-control": "no-store" },
  );
}
