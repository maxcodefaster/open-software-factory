import { expect, test } from "bun:test";
import { projectImportOrigins } from "./setup";

test("Git import policy uses exact HTTPS origins and fails closed for an empty allowlist", () => {
  expect(projectImportOrigins()).toEqual([
    "https://github.com",
    "https://gitlab.com",
    "https://codeberg.org",
  ]);
  expect(
    projectImportOrigins(" https://git.enterprise.test:8443/,https://git.enterprise.test:8443 "),
  ).toEqual(["https://git.enterprise.test:8443"]);
  expect(projectImportOrigins("")).toEqual([]);
  for (const value of [
    "http://git.test",
    "https://user:secret@git.test",
    "https://git.test/path",
    "https://git.test?secret",
    "https://*.git.test",
    "https://git.test\nspoof",
  ])
    expect(() => projectImportOrigins(value)).toThrow();
});

import { projectImportURL, projectSetupSave } from "./setup";

test("Git import requires an approved HTTPS forge without credentials or unsafe paths", () => {
  expect(projectImportURL("https://github.com/team/product.git", ["https://github.com"])).toBe(
    "https://github.com/team/product.git",
  );
  for (const url of [
    "http://github.com/a/b",
    "https://key@github.com/a/b",
    "https://github.com/a/b?token=secret",
    "https://127.0.0.1/repo",
    "https://github.com\\@evil.test/repo",
    "https://evil.test/repo",
    "https://github.com/a/%2e%2e/b",
  ])
    expect(() => projectImportURL(url, ["https://github.com"])).toThrow();
});

test("setup persistence cannot include a credential", () => {
  expect(
    projectSetupSave.safeParse({
      id: crypto.randomUUID(),
      version: 1,
      name: "App",
      slug: "app",
      kind: "starter",
      sourceURL: "",
      importToken: "secret",
    }).success,
  ).toBe(false);
});
