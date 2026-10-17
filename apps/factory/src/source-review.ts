export function sourceReviewURL(pullRequestURL: string | undefined) {
  if (!pullRequestURL) return undefined;
  try {
    const url = new URL(pullRequestURL);
    const path = url.pathname.replace(/\/$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !/\/pulls\/[1-9]\d*$/.test(path)
    )
      return undefined;
    url.pathname = `${path}/files`;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}
