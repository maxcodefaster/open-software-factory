export function runtimeFactoryURL(path: string) {
  const url = new URL(path, process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000");
  return runtimeHostURL(url);
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
  return url.origin === configured.origin ? runtimeHostURL(url) : repositoryURL;
}

export function runtimeForgeURL() {
  return runtimeHostURL(new URL("/", process.env["FACTORY_FORGEJO_API_URL"]));
}
