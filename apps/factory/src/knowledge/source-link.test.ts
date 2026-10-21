import { expect, test } from "bun:test";
import { repositoryBrowserURL, repositoryLink } from "./source-link";

test("browser source links use the public forge without changing the retained transport URL", () => {
  const retained = "http://factory-forgejo.factory.svc:3000/factory/project.git";
  const origins = {
    browser: "https://git.example.com",
    transport: "http://factory-forgejo.factory.svc:3000",
  };
  const browser = repositoryBrowserURL(retained, origins);
  expect(browser).toBe("https://git.example.com/factory/project.git");
  if (!browser) throw new Error("Public repository link is missing");
  expect(retained).toBe("http://factory-forgejo.factory.svc:3000/factory/project.git");
  expect(repositoryLink(browser, "a".repeat(40), "src/index.ts")).toBe(
    `https://git.example.com/factory/project/src/commit/${"a".repeat(40)}/src/index.ts`,
  );
  expect(repositoryBrowserURL(browser, origins)).toBe(browser);
  expect(repositoryBrowserURL("https://elsewhere.example/team/app.git", origins)).toBe(
    "https://elsewhere.example/team/app.git",
  );
});

test("browser repository projection does not turn credentials or local files into public links", () => {
  const origins = {
    browser: "https://git.example.com",
    transport: "http://factory-forgejo.factory.svc:3000",
  };
  for (const value of [
    "http://key@factory-forgejo.factory.svc:3000/team/app.git",
    "file:///tmp/repository",
    "javascript:alert(1)",
    "not a URL",
  ])
    expect(repositoryBrowserURL(value, origins)).toBeUndefined();
  expect(
    repositoryBrowserURL("https://git.example.com/team/app.git", {
      ...origins,
      browser: "https://key@git.example.com",
    }),
  ).toBeUndefined();
  expect(repositoryBrowserURL("https://git.example.com/team/app.git")).toBe(
    "https://git.example.com/team/app.git",
  );
});

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
