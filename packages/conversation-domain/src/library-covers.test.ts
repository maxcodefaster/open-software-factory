import { expect, test } from "bun:test";
import { defaultLibraryCover, libraryCoverCatalog, libraryCoverInput } from "./library-covers";

test("the cover catalog contains thirty distinct named motifs and stable defaults", () => {
  expect(libraryCoverCatalog).toHaveLength(30);
  expect(new Set(libraryCoverCatalog.map((cover) => cover.key)).size).toBe(30);
  expect(new Set(libraryCoverCatalog.map((cover) => cover.name)).size).toBe(30);
  const identity = "10000000-0000-4000-8000-000000000001";
  expect(defaultLibraryCover(identity)).toBe(defaultLibraryCover(identity));
  const defaults = Array.from({ length: 300 }, (_, i) =>
    defaultLibraryCover(`10000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
  );
  expect(new Set(defaults).size).toBe(30);
  expect(defaults.every((key) => libraryCoverCatalog.some((cover) => cover.key === key))).toBe(
    true,
  );
});

test("cover commands accept catalog keys, never image URLs or arbitrary paths", () => {
  const input = {
    libraryId: crypto.randomUUID(),
    key: "woven-ribbons" as const,
    expectedVersion: 1,
  };
  expect(libraryCoverInput.parse(input)).toEqual(input);
  for (const key of ["https://example.com/image.webp", "../skills/code-review", "unknown", ""])
    expect(libraryCoverInput.safeParse({ ...input, key }).success).toBe(false);
  expect(libraryCoverInput.safeParse({ ...input, expectedVersion: -1 }).success).toBe(false);
  expect(libraryCoverInput.safeParse({ ...input, content: {} }).success).toBe(false);
});
