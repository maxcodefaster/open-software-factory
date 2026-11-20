import { expect, test } from "bun:test";
import { decodeUTF8Text, UTF8TextPageError, utf8TextPage } from "./text-page";

test("UTF-8 byte pages return complete characters without exceeding any requested window", () => {
  const text = "A¢€😀\ufeff�\x00é界🦊B";
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  for (const character of text) {
    const width = new TextEncoder().encode(character).length;
    for (let limit = 1; limit <= 8; limit++) {
      if (limit < width) {
        expect(() => utf8TextPage(bytes, offset, limit)).toThrow("increase limit");
        continue;
      }
      const page = utf8TextPage(bytes, offset, limit);
      const length = new TextEncoder().encode(page.content).length;
      expect(length).toBeLessThanOrEqual(limit);
      expect(page.nextOffset).toBe(offset + length < bytes.length ? offset + length : null);
      expect(page.content.startsWith(character)).toBe(true);
      expect(new TextEncoder().encode(page.content)).toEqual(
        bytes.subarray(offset, offset + length),
      );
    }
    for (let continuation = 1; continuation < width; continuation++)
      expect(() => utf8TextPage(bytes, offset + continuation, 4)).toThrow("character boundary");
    offset += width;
  }
  expect(utf8TextPage(bytes, offset, 1)).toEqual({ content: "", nextOffset: null });
  expect(utf8TextPage(new Uint8Array(), 0, 1)).toEqual({ content: "", nextOffset: null });
});

test("strict text decoding preserves literal replacement characters and BOMs on every page", () => {
  const bytes = new TextEncoder().encode("\ufeff�\ufeff");
  expect(decodeUTF8Text(bytes)).toBe("\ufeff�\ufeff");
  expect(utf8TextPage(bytes, 0, 3)).toEqual({ content: "\ufeff", nextOffset: 3 });
  expect(utf8TextPage(bytes, 3, 3)).toEqual({ content: "�", nextOffset: 6 });
  expect(utf8TextPage(bytes, 6, 3)).toEqual({ content: "\ufeff", nextOffset: null });
});

test("UTF-8 byte pages reject invalid encoding even in a split trailing character", () => {
  for (const content of [
    [0x80],
    [0xc0, 0xaf],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
    [0xff],
    [0x41, 0xe2, 0x82],
    [0x41, 0xe2, 0x28, 0xa1],
    [0x41, 0xe2, 0x82, 0x42],
  ])
    expect(() => utf8TextPage(Uint8Array.from(content), 0, 2)).toThrow("invalid encoding");
  expect(() => decodeUTF8Text(Uint8Array.from([0xe2, 0x82]))).toThrow(UTF8TextPageError);
  expect(decodeUTF8Text(new TextEncoder().encode("valid after a rejected decode"))).toBe(
    "valid after a rejected decode",
  );
});

test("UTF-8 byte paging rejects out-of-range offsets and nonpositive budgets", () => {
  const bytes = new TextEncoder().encode("A€B");
  for (const offset of [-1, 6, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => utf8TextPage(bytes, offset, 4)).toThrow(UTF8TextPageError);
  for (const limit of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => utf8TextPage(bytes, 0, limit)).toThrow(UTF8TextPageError);
});
