export function skillInvocationQuery(text: string, start: number, end = start) {
  if (start !== end) return null;
  return /(?:^|\s)\/([a-z0-9-]*)$/.exec(text.slice(0, start))?.[1] ?? null;
}

/** Insert guidance into the human draft. This never sends or activates anything. */
export function insertSkillInvocation(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  key: string,
) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(key)) throw new Error("Invalid Skill invocation");
  const start = Math.max(0, Math.min(text.length, selectionStart));
  const end = Math.max(start, Math.min(text.length, selectionEnd));
  const partial = /(?:^|\s)\/[a-z0-9-]*$/.exec(text.slice(0, start));
  const replaceFrom = partial ? start - partial[0].trimStart().length : start;
  const prefix = replaceFrom > 0 && !/\s/.test(text.charAt(replaceFrom - 1)) ? " " : "";
  const inserted = `${prefix}/${key} `;
  return {
    text: text.slice(0, replaceFrom) + inserted + text.slice(end),
    cursor: replaceFrom + inserted.length,
  };
}
