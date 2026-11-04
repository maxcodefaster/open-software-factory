const footer = /^(?:#{1,6}\s+)?sources\s*:?\s*$/im;
const fence = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/;

/** Removes a closing "Sources" section. Factory supplies provenance, so a repair round is wasted on it. */
export function stripSourcesFooter(body: string) {
  const match = footer.exec(body);
  if (!match) return body;
  const rest = body.slice(match.index + match[0].length);
  // A later heading means the section is not a footer; leave it to the writer to repair.
  if (/^#{1,6}\s+\S/m.test(rest)) return body;
  return body.slice(0, match.index).trimEnd();
}

/**
 * Turns a link to a guide that is not published (planned for later, or a slug the writer got
 * wrong) into plain text. The words survive; a writer round to say so costs two sequential
 * model calls.
 */
export function unlinkUnavailableGuides(body: string, published: ReadonlySet<string>) {
  return body
    .split(fence)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /\[([^\]\n]+)\]\(#wiki\/([a-z0-9]+(?:-[a-z0-9]+)*)\)/g,
            (link, text, slug) => (published.has(slug) ? link : text),
          ),
    )
    .join("");
}
