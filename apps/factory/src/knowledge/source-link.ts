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
