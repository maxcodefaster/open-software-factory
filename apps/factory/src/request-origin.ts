import { isolatedRuntimeOrigin } from "./runtime-origins";

// TLS ends at the operator's Ingress. Restore only the configured public
// identities from its preserved Host, never a caller's forwarded headers.
// Internal Services and unrelated listeners retain their actual transport URL.
export function factoryRequestURL(request: Request, factoryOrigin?: string) {
  const received = new URL(request.url);
  if (!factoryOrigin) return received;
  const configured = new URL(factoryOrigin);
  if (
    !["http:", "https:"].includes(configured.protocol) ||
    configured.username ||
    configured.password ||
    configured.pathname !== "/" ||
    configured.search ||
    configured.hash
  )
    throw new Error("Factory public URL must be an HTTP(S) origin");
  if (received.protocol !== "http:" || configured.protocol !== "https:") return received;
  const publicURL = new URL(received);
  publicURL.protocol = configured.protocol;
  if (publicURL.host === configured.host) return publicURL;
  const runtimeSuffix = new URL(isolatedRuntimeOrigin(configured.origin, "request")).hostname.slice(
    "request".length,
  );
  const label = publicURL.hostname.slice(0, -runtimeSuffix.length);
  if (
    publicURL.port === configured.port &&
    publicURL.hostname.endsWith(runtimeSuffix) &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  )
    return publicURL;
  return received;
}
