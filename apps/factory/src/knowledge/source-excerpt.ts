export type SourceFile = { path: string; content: string };
export type SourceExcerpt = {
  path: string;
  content: string;
  truncated?: true;
  totalLines?: number;
  nextStartLine?: number;
};

/**
 * A bounded view of one file. The whole text stays in the Topic's read set for citation checks;
 * agents receive at most maxChars and a 1-based nextStartLine to continue with readSource.
 */
export function sourceExcerpt(file: SourceFile, maxChars: number, startLine = 1): SourceExcerpt {
  if (startLine <= 1 && file.content.length <= maxChars) return file;
  if (maxChars <= 0)
    return {
      path: file.path,
      content: "",
      truncated: true,
      nextStartLine: Math.max(startLine, 1),
      totalLines: file.content.split("\n").length,
    };
  const lines = file.content.split("\n");
  const selected: string[] = [];
  let length = 0;
  let index = Math.min(Math.max(startLine, 1) - 1, lines.length);
  for (; index < lines.length; index++) {
    const size = (lines[index]?.length ?? 0) + (selected.length ? 1 : 0);
    if (length + size > maxChars) break;
    selected.push(lines[index] ?? "");
    length += size;
  }
  // One line longer than the whole budget is cut rather than hidden.
  if (!selected.length && index < lines.length) {
    selected.push((lines[index] ?? "").slice(0, Math.max(maxChars, 0)));
    index++;
  }
  const more = index < lines.length;
  return {
    path: file.path,
    content: selected.join("\n"),
    ...(more ? { truncated: true as const, nextStartLine: index + 1 } : {}),
    ...(more || startLine > 1 ? { totalLines: lines.length } : {}),
  };
}

/** Excerpts for a prompt. Files past the shared budget keep only their path and a truncated flag. */
export function promptSources(
  files: Iterable<SourceFile>,
  limits: { perFile: number; total: number },
): SourceExcerpt[] {
  let remaining = limits.total;
  return [...files].map((file) => {
    if (remaining <= 0) return { path: file.path, content: "", truncated: true as const };
    const excerpt = sourceExcerpt(file, Math.min(limits.perFile, remaining));
    remaining -= excerpt.content.length;
    return excerpt;
  });
}

export function pageExcerpt(body: string, maxChars: number) {
  const text = body.trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
