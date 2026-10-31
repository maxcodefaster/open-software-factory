import { createHash } from "node:crypto";
import { runtimeDocumentRequest } from "./demand";

// Only Factory's own failed App navigation is replaced. App responses, JSON
// API calls and mutations keep their native status/body and are never replayed.
export function previewAttachmentFailure(
  request: Request,
  factoryOrigin: string,
  response: Response,
) {
  if (
    response.ok ||
    !runtimeDocumentRequest(request) ||
    !/^\/runtime\/[0-9a-f-]{36}\/(?:app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)(?:\/|$)/.test(
      new URL(request.url).pathname,
    )
  )
    return response;
  const origin = new URL(factoryOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== factoryOrigin)
    throw new Error("Preview attachment requires its configured Factory origin");
  const script = `window.parent.postMessage({type:"factory-preview-document-failed"},${JSON.stringify(factoryOrigin)})`;
  const hash = createHash("sha256").update(script).digest("base64");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Preview connection unavailable</title><p>Could not open Preview. Reload this view to retry.</p><script>${script}</script>`,
    {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; script-src 'sha256-${hash}'; frame-ancestors 'self' ${factoryOrigin}`,
      },
    },
  );
}
