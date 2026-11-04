const code = /`([^`\n]+)`/g;
const identifier =
  /[A-Za-z_][A-Za-z0-9_]*(?:[./:-][A-Za-z0-9_]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]{2,}/g;

/** Facts a reader can check: numbers, code spans, paths, identifiers, URLs and wiki links. */
export function factTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of body.matchAll(code)) {
    const value = match[1];
    if (value) tokens.add(value.trim().toLowerCase());
  }
  for (const match of body.matchAll(/\d+(?:[.,:]\d+)*/g)) tokens.add(match[0]);
  for (const match of body.matchAll(/https?:\/\/[^\s)>\]]+|#wiki\/[a-z0-9-]+/g))
    tokens.add(match[0].toLowerCase());
  for (const match of body.matchAll(identifier)) tokens.add(match[0].toLowerCase());
  return tokens;
}

/**
 * True when the draft only rewords the checked page: it adds no fact token, grows by at most a
 * fifth and none of its cited files changed. The independent page check is for new facts.
 */
export function wordingOnlyChange(input: {
  current: string;
  draft: string;
  cited: readonly string[];
  changedPaths: readonly string[];
}): boolean {
  if (input.cited.some((path) => input.changedPaths.includes(path))) return false;
  if (input.draft.length > input.current.length * 1.2) return false;
  const known = factTokens(input.current);
  for (const token of factTokens(input.draft)) if (!known.has(token)) return false;
  return true;
}
