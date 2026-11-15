// Actor callbacks use their immutable native Connector origin. The control
// plane's private HTTP backchannel is neither reachable nor admitted there.
export function substrateFactoryURL(path: string, binding: unknown) {
  const { connectorURL } = z.object({ connectorURL: z.url() }).parse(binding);
  const url = new URL(connectorURL);
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.pathname !== "/internal/runtime-connect" ||
    url.search ||
    url.hash
  )
    throw new Error("Native callback requires the exact admitted WSS Connector binding");
  url.protocol = "https:";
  const callback = new URL(path, url.origin);
  if (
    !path.startsWith("/internal/") ||
    callback.origin !== url.origin ||
    !callback.pathname.startsWith("/internal/") ||
    callback.search ||
    callback.hash
  )
    throw new Error("Native callback must stay within its bound Factory origin");
  return callback.href;
}

function runtimeHostURL(url: URL) {
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    url.hostname = process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal";
  }
  return url.toString();
}

// Native Actors may reach only the immutable Connector binding's admitted TLS
// destinations. Never translate Git to a legacy internal HTTP Service or host.
export function substrateRepositoryCloneURL(
  repositoryURL: string,
  binding: unknown,
  environment: Record<string, string | undefined> = process.env,
) {
  const native = z
    .object({ connectorURL: z.url(), egressHosts: z.array(z.string()).default([]) })
    .parse(binding);
  const connector = new URL(native.connectorURL);
  const publicURL = environment["FACTORY_FORGEJO_PUBLIC_URL"];
  const apiURL = environment["FACTORY_FORGEJO_API_URL"];
  if (!publicURL || !apiURL)
    throw new Error("Native Git requires the configured Forge HTTPS origin");
  const forge = new URL(publicURL);
  const repository = new URL(repositoryURL);
  if (
    connector.protocol !== "wss:" ||
    connector.username ||
    connector.password ||
    connector.search ||
    connector.hash ||
    connector.pathname !== "/internal/runtime-connect" ||
    forge.protocol !== "https:" ||
    forge.username ||
    forge.password ||
    forge.pathname !== "/" ||
    forge.search ||
    forge.hash ||
    Number(forge.port || 443) !== Number(connector.port || 443) ||
    ![connector.hostname, ...native.egressHosts].includes(forge.hostname)
  )
    throw new Error("Native Git requires an admitted Forge TLS origin on the pinned port");
  const parts = repository.pathname.split("/").slice(1).map(decodeURIComponent);
  if (
    !["http:", "https:"].includes(repository.protocol) ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash ||
    ![new URL(apiURL).origin, forge.origin].includes(repository.origin) ||
    parts.length !== 2 ||
    parts.some((part) => !part || part === "." || part === ".." || /[/\\\0]/.test(part))
  )
    throw new Error("Native Git repository is outside the configured Forge");
  const destination = new URL(forge.origin);
  destination.pathname = repository.pathname;
  return destination.href;
}

export function runtimeForgeURL() {
  return runtimeHostURL(new URL("/", process.env["FACTORY_FORGEJO_API_URL"]));
}

export function runtimeReleaseRegistryURL() {
  const configured = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  if (configured) {
    const url = new URL(configured);
    if (url.protocol === "https:") return url.origin;
  }
  return runtimeForgeURL();
}

import { z } from "zod";
