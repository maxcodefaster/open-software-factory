import { previewBridge } from "../review/preview-bridge";
import rendererSource from "modern-screenshot/dist/index.js" with { type: "text" };
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export function previewBridgeResponse(factoryOrigin: string) {
  return new Response(previewBridge(factoryOrigin), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function previewRendererResponse() {
  return new Response(rendererSource, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function scopeRuntimeEmbedding(
  response: Response,
  factoryOrigin: string,
  bridgePath?: string,
) {
  const origin = new URL(factoryOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== factoryOrigin) {
    throw new Error("Factory embedding requires its configured HTTP origin");
  }
  const headers = new Headers(response.headers);
  const ancestors = `frame-ancestors 'self' ${factoryOrigin}`;
  const policy = headers.get("content-security-policy");
  const directive = /(^|[;,])\s*frame-ancestors(?:\s+[^;,]*)?/gi;
  headers.set(
    "content-security-policy",
    policy
      ? directive.test(policy)
        ? policy.replace(directive, `$1 ${ancestors}`)
        : `${policy}; ${ancestors}`
      : ancestors,
  );
  // Factory is the authorized embedding shell. Keep App script/style policies, but
  // replace conflicting ancestor restrictions with this exact configured origin.
  headers.delete("x-frame-options");
  let body = response.body;
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (
    body &&
    bridgePath &&
    response.ok &&
    headers.get("content-type")?.includes("text/html") &&
    (!encoding || ["identity", "gzip", "deflate", "br"].includes(encoding))
  ) {
    if (
      !/^\/runtime\/[a-f0-9-]+\/(?:app|preview\/app(?:-[a-z][a-z0-9-]*)?)\/__factory\/review-bridge\.js$/.test(
        bridgePath,
      )
    )
      throw new Error("Preview bridge needs its fixed runtime path");
    const script = `<script src="${bridgePath}"></script>`;
    // Do not weaken the App's script CSP. Strict policies may disable element
    // selection. General feedback remains available without App-side scripting.
    headers.delete("content-length");
    headers.delete("etag");
    if (encoding && encoding !== "identity") {
      const decoder =
        encoding === "br"
          ? createBrotliDecompress()
          : encoding === "gzip"
            ? createGunzip()
            : createInflate();
      const source = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      body = Readable.toWeb(source.pipe(decoder)) as unknown as NonNullable<Response["body"]>;
      headers.delete("content-encoding");
    }
    body = new HTMLRewriter()
      .onDocument({
        end(document) {
          document.append(script, { html: true });
        },
      })
      .transform(new Response(body)).body;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
