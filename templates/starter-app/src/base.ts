import { getRequestEvent } from "@solidjs/web";
import { appProxyContext } from "./proxy.ts";

export function applicationBase() {
  if (typeof document !== "undefined") return new URL(document.baseURI).pathname.replace(/\/$/, "");
  const request = getRequestEvent()?.request;
  return request ? (appProxyContext(request.headers)?.basePath ?? "") : "";
}

export function scopedAsset(url: string, basePath: string) {
  const parsed = new URL(url, "http://assets.local");
  if (parsed.origin !== "http://assets.local") return url;
  const path = parsed.pathname;
  return (
    (basePath && !path.startsWith(`${basePath}/`) ? basePath + path : path) +
    parsed.search +
    parsed.hash
  );
}
