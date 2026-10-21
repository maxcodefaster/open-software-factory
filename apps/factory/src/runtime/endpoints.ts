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

export function runtimeForgeURL() {
  return runtimeHostURL(new URL("/", process.env["FACTORY_FORGEJO_API_URL"]));
}
