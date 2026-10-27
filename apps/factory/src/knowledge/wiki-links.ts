import { Marked } from "marked";

// Inspect Markdown tokens, not code examples or text inside an authored link.
export function wikiLinkIssues(
  body: string,
  pages: readonly { slug: string; title: string; state: string }[],
): string[] {
  const titles = new Map(
    pages.filter((page) => page.state === "active").map((page) => [page.slug, page.title]),
  );
  const issues = new Set<string>();
  function inspect(value: unknown) {
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const token = value as Record<string, unknown>;
    if (token["type"] === "link") {
      const slug =
        typeof token["href"] === "string" && /^#wiki\/([a-z0-9-]+)$/.exec(token["href"])?.[1];
      if (slug && !titles.has(slug)) issues.add(`Unavailable internal link ${slug}`);
      return;
    }
    if (["code", "codespan", "html", "image"].includes(String(token["type"]))) return;
    if (token["type"] === "text" && !token["tokens"] && typeof token["text"] === "string") {
      for (const match of token["text"].matchAll(/#wiki\/([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w/-])/g)) {
        const slug = match[1];
        if (!slug) continue;
        const title = titles.get(slug);
        issues.add(
          title
            ? `Use the Markdown link [${title}](#wiki/${slug}) instead of the bare #wiki/${slug} reference.`
            : `Unavailable internal link ${slug}`,
        );
      }
    }
    for (const key of ["tokens", "items", "header", "rows"]) inspect(token[key]);
  }
  inspect(new Marked().lexer(body));
  return [...issues];
}
