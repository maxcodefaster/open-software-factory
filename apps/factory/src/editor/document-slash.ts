/** Only a slash command at a word boundary, before the caret, opens the block menu. */
export function documentSlash(textBeforeCaret: string) {
  const match = /(?:^|\s)\/([\p{L}\p{N}-]{0,40})$/u.exec(textBeforeCaret);
  if (!match) return;
  const query = match[1] ?? "";
  return { query, length: query.length + 1 };
}

export function filterDocumentBlocks<T extends { id: string; label: string }>(
  blocks: readonly T[],
  query: string,
): T[] {
  const search = query.toLocaleLowerCase();
  return blocks.filter(
    (block) => block.label.toLocaleLowerCase().includes(search) || block.id.includes(search),
  );
}
