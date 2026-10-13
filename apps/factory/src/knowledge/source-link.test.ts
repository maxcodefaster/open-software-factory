import { expect, test } from "bun:test";
import { repositoryLink } from "./source-link";
test("source links point at the exact commit and encode nested paths without credentials", () => {
  const sha = "a".repeat(40);
  expect(repositoryLink("https://forge.example/team/app.git", sha, "docs/A guide.md")).toBe(
    `https://forge.example/team/app/src/commit/${sha}/docs/A%20guide.md`,
  );
  expect(repositoryLink("https://forge.example/team/app.git", sha)).toBe(
    `https://forge.example/team/app/commit/${sha}`,
  );
  expect(repositoryLink("javascript:alert(1)", sha)).toBeUndefined();
  expect(repositoryLink("https://key@forge.example/app", sha)).toBeUndefined();
  expect(repositoryLink("https://forge.example/team/app", sha, "../secret")).toBeUndefined();
});
