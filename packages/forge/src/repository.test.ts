import { expect, test } from "bun:test";
import { forgeRepositoryFromURL } from "./repository";

test("reads owner and name and rejects incomplete paths", () => {
  expect(forgeRepositoryFromURL("https://forge.example/acme/site.git")).toEqual({
    owner: "acme",
    name: "site",
  });
  expect(forgeRepositoryFromURL("https://forge.example/git/acme/site/")).toEqual({
    owner: "acme",
    name: "site",
  });
  expect(() => forgeRepositoryFromURL("https://forge.example/site")).toThrow("Forge repository");
  expect(() =>
    forgeRepositoryFromURL("https://forge.example/", () => new RangeError("custom")),
  ).toThrow("custom");
});
