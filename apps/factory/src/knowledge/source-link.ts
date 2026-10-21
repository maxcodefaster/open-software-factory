export type RepositoryOrigins = { browser: string; transport: string };

export function repositoryBrowserURL(
  repositoryURL: string,
  origins?: RepositoryOrigins,
): string | undefined {
  try {
    const url = new URL(repositoryURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    if (origins) {
      const browser = new URL(origins.browser);
      const transport = new URL(origins.transport);
      for (const origin of [browser, transport])
        if (
          !["http:", "https:"].includes(origin.protocol) ||
          origin.username ||
          origin.password ||
          origin.pathname !== "/" ||
          origin.search ||
          origin.hash
        )
          return;
      if (url.origin === transport.origin) {
        url.protocol = browser.protocol;
        url.host = browser.host;
        url.port = browser.port;
      }
    }
    return url.href;
  } catch {
    return;
  }
}

export function repositoryLink(repositoryURL: string, commit: string, path?: string) {
  try {
    const url = new URL(repositoryURL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)
    )
      return;
    const repository = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    if (
      path !== undefined &&
      (path.split("/").some((part) => !part || part === "." || part === "..") ||
        path.includes("\\"))
    )
      return;
    url.pathname =
      path === undefined
        ? `${repository}/commit/${commit}`
        : `${repository}/src/commit/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return;
  }
}
