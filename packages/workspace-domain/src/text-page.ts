export class UTF8TextPageError extends Error {}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const invalidEncoding = "UTF-8 text page contains invalid encoding; use a binary file transfer";

export function decodeUTF8Text(content: Uint8Array): string {
  try {
    return decoder.decode(content);
  } catch {
    throw new UTF8TextPageError(invalidEncoding);
  }
}

/**
 * Offsets and limits count bytes. An offset must start a character. Return only
 * complete UTF-8 characters within the requested window, deferring a split tail
 * to nextOffset. Reject malformed text, including a truncated character at EOF,
 * and a budget that cannot fit the next character. Never return a stalled page.
 * Validation needs at most three bytes beyond the requested end.
 */
export function utf8TextPage(bytes: Uint8Array, offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
    throw new UTF8TextPageError("UTF-8 text page offset exceeds file size");
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new UTF8TextPageError("UTF-8 text page limit must be positive");
  if (offset > 0 && offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80)
    throw new UTF8TextPageError("UTF-8 text page offset must be a character boundary");
  const end = offset + Math.min(limit, bytes.length - offset);
  let cursor = offset;
  while (cursor < end) {
    const first = bytes[cursor] ?? 0;
    const width =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
    if (!width || cursor + width > bytes.length) throw new UTF8TextPageError(invalidEncoding);
    for (let index = 1; index < width; index++)
      if (((bytes[cursor + index] ?? 0) & 0xc0) !== 0x80)
        throw new UTF8TextPageError(invalidEncoding);
    const second = bytes[cursor + 1] ?? 0;
    if (
      (first === 0xe0 && second < 0xa0) ||
      (first === 0xed && second >= 0xa0) ||
      (first === 0xf0 && second < 0x90) ||
      (first === 0xf4 && second >= 0x90)
    )
      throw new UTF8TextPageError(invalidEncoding);
    if (cursor + width > end) break;
    cursor += width;
  }
  if (cursor === offset && offset < bytes.length)
    throw new UTF8TextPageError(
      "UTF-8 text page limit cannot fit the next character; increase limit",
    );
  return {
    content: decodeUTF8Text(bytes.subarray(offset, cursor)),
    nextOffset: cursor < bytes.length ? cursor : null,
  };
}
