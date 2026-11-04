import { expect, test } from "bun:test";
import { pageExcerpt, promptSources, sourceExcerpt } from "./source-excerpt";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

test("a small file is returned unchanged and a long one is cut at a line with a resume point", () => {
  const small = { path: "a.ts", content: "const a = 1;" };
  expect(sourceExcerpt(small, 100)).toBe(small);
  const long = { path: "b.ts", content: lines(100).join("\n") };
  const first = sourceExcerpt(long, 50);
  expect(first.truncated).toBe(true);
  expect(first.content.length).toBeLessThanOrEqual(50);
  expect(first.totalLines).toBe(100);
  expect(first.content.split("\n").at(-1)).toBe(`line ${(first.nextStartLine ?? 0) - 1}`);
  const next = sourceExcerpt(long, 50, first.nextStartLine);
  expect(next.content.startsWith(`line ${first.nextStartLine}`)).toBe(true);
});

test("the last range reports no further truncation and a single huge line is cut, not hidden", () => {
  const long = { path: "c.ts", content: lines(10).join("\n") };
  const tail = sourceExcerpt(long, 1000, 8);
  expect(tail).toEqual({ path: "c.ts", content: "line 8\nline 9\nline 10", totalLines: 10 });
  const minified = sourceExcerpt({ path: "d.js", content: "x".repeat(500) }, 100);
  expect(minified.content).toHaveLength(100);
  expect(sourceExcerpt({ path: "e.ts", content: "abc" }, 0)).toMatchObject({
    content: "",
    truncated: true,
    nextStartLine: 1,
  });
});

test("prompt sources share one budget and keep every path visible", () => {
  const files = [1, 2, 3].map((index) => ({ path: `f${index}.ts`, content: "y".repeat(400) }));
  const shown = promptSources(files, { perFile: 300, total: 500 });
  expect(shown.map((file) => file.path)).toEqual(["f1.ts", "f2.ts", "f3.ts"]);
  expect(shown.reduce((total, file) => total + file.content.length, 0)).toBeLessThanOrEqual(500);
  expect(shown[2]).toEqual({ path: "f3.ts", content: "", truncated: true });
  expect(pageExcerpt("  short  ", 20)).toBe("short");
  expect(pageExcerpt("x".repeat(30), 20)).toBe(`${"x".repeat(20)}…`);
});
