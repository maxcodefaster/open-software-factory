import { expect, test } from "bun:test";
import { searchSnippet } from "./search-snippet";

test("shows a bounded readable excerpt around a body match", () => {
  const snippet = searchSnippet(
    `${"Introduction ".repeat(30)}## Build\nRun **node** locally. ${"Details ".repeat(40)}`,
    ["node"],
  );
  expect(snippet).toContain("node locally");
  expect(snippet).toStartWith("…");
  expect(snippet).toEndWith("…");
  expect(snippet.length).toBeLessThanOrEqual(182);
});
