import { createStartHandler, defaultStreamHandler } from "@tanstack/solid-start/server";
import { createServerEntry } from "@tanstack/solid-start/server-entry";
import { applicationBase, scopedAsset } from "./base.ts";
import { trustedAppOrigins } from "./auth.ts";
import { appProxyContext } from "./proxy.ts";

const handler = createStartHandler({
  handler: defaultStreamHandler,
  transformAssets: {
    cache: false,
    transform: ({ url }) => scopedAsset(url, applicationBase()),
  },
});

export default createServerEntry({
  async fetch(request) {
    const proxy = appProxyContext(request.headers);
    const baseURL = process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 4300}`;
    const incoming = new URL(request.url);
    const origin = request.headers.get("origin");
    const url = new URL(
      proxy?.origin ?? (origin && trustedAppOrigins(baseURL).includes(origin) ? origin : baseURL),
    );
    const prefix = proxy?.basePath ?? "";
    const path =
      prefix && incoming.pathname.startsWith(`${prefix}/`)
        ? incoming.pathname.slice(prefix.length)
        : incoming.pathname;
    // Native function dispatch uses Start's fixed endpoint. Page URLs retain
    // their public mount for the router's per-request input/output rewrite.
    url.pathname = path.startsWith("/_server/") ? path : prefix + path;
    url.search = incoming.search;
    const response = await handler(new Request(url, request));
    response.headers.set("cache-control", "no-store");
    return response;
  },
});
