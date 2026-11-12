export function runtimeFactoryURL(path: string) {
  const internal = process.env["FACTORY_INTERNAL_URL"];
  if (internal) return new URL(path, requireInternalOrigin(internal)).toString();
  const url = new URL(path, process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000");
  return runtimeHostURL(url);
}

function requireInternalOrigin(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("FACTORY_INTERNAL_URL must be an HTTP(S) origin without credentials or a path");
  return url;
}

function runtimeHostURL(url: URL) {
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    url.hostname = process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal";
  }
  return url.toString();
}

export function runtimeRepositoryCloneURL(repositoryURL: string) {
  const apiURL = process.env["FACTORY_FORGEJO_API_URL"];
  if (!apiURL) return repositoryURL;
  const configured = new URL(apiURL);
  const url = new URL(repositoryURL);
  const publicURL = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  if (url.origin === configured.origin || (publicURL && url.origin === new URL(publicURL).origin)) {
    url.protocol = configured.protocol;
    url.host = configured.host;
    return runtimeHostURL(url);
  }
  return repositoryURL;
}

// Native Actors may reach only the immutable Connector binding's admitted TLS
// destinations. Never translate Git to a legacy internal HTTP Service or host.
export function substrateRepositoryCloneURL(repositoryURL: string, binding: unknown) {
  const native = z
    .object({ connectorURL: z.url(), egressHosts: z.array(z.string()).default([]) })
    .parse(binding);
  const connector = new URL(native.connectorURL);
  const publicURL = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  const apiURL = process.env["FACTORY_FORGEJO_API_URL"];
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
