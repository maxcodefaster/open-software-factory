import { expect, test } from "bun:test";
import { sourceReviewURL } from "./source-review";

test("source review opens the exact Forgejo pull request's changed files", () => {
  expect(sourceReviewURL("http://127.0.0.1:33030/owned/project/pulls/7")).toBe(
    "http://127.0.0.1:33030/owned/project/pulls/7/files",
  );
  expect(
    sourceReviewURL("https://forge.example/prefix/owned/project/pulls/12/?tab=conversation#latest"),
  ).toBe("https://forge.example/prefix/owned/project/pulls/12/files");
  for (const value of [
    undefined,
    "",
    "javascript:alert(1)",
    "https://secret@forge.example/a/b/pulls/1",
    "https://forge.example/a/b",
    "https://forge.example/a/b/pulls/0",
  ])
    expect(sourceReviewURL(value)).toBeUndefined();
});
