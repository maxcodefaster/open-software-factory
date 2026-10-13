export function searchSnippet(body: string, terms: readonly string[]) {
  const text = body
    .replaceAll(/[#*`>|]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  const lower = text.toLocaleLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 50);
  const excerpt = text.slice(start, start + 180);
  return `${start ? "…" : ""}${excerpt}${start + excerpt.length < text.length ? "…" : ""}`;
}
