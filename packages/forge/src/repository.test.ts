import { expect, test } from "bun:test";
import {
  forgeBinding,
  forgeRepositoryBindingMatrix,
} from "../../../test/support/forge-repository-binding";
import { boundForgeRepositoryFromURL, forgeRepositoryFromURL } from "./repository";

test("Project binding shares one strict public/private and malformed URL matrix", () => {
  const { accepted, malformed } = forgeRepositoryBindingMatrix();
  for (const { url, repository } of accepted)
    expect(boundForgeRepositoryFromURL(url, forgeBinding)).toEqual(repository);
  for (const url of malformed) {
    const failure = new RangeError("Owned binding rejected");
    expect(() => boundForgeRepositoryFromURL(url, forgeBinding, () => failure)).toThrow(failure);
  }
});

test("binding preserves configured HTTP/HTTPS, host casing, default ports and an API-only origin", () => {
  for (const apiURL of ["http://forge.example/api/v1/", "https://forge.example/api/v1/"]) {
    const origin = new URL(apiURL).origin;
    const binding = { apiURL, owner: "factory" };
    for (const url of [
      `${origin}/factory/repo.git`,
      `${origin.replace("forge.example", "FORGE.EXAMPLE")}/factory/repo.git`,
      `${origin}:${apiURL.startsWith("https:") ? 443 : 80}/factory/repo.git`,
    ])
      expect(boundForgeRepositoryFromURL(url, binding)).toEqual({
        owner: "factory",
        name: "repo",
      });
    expect(() =>
      boundForgeRepositoryFromURL("https://unconfigured.example/factory/repo.git", binding),
    ).toThrow("configured forge");
  }
  expect(() =>
    boundForgeRepositoryFromURL("https://git.native.test/owned/repo.git", {
      ...forgeBinding,
      apiURL: "malformed",
    }),
  ).toThrow("configured forge");
  for (const [apiURL, publicURL] of [
    ["https://private.example/api/v1/", "http://public.example:8080"],
    ["https://[::1]:3000/api/v1/", "https://bücher.example"],
  ] as const)
    for (const origin of [new URL(apiURL).origin, new URL(publicURL).origin])
      expect(
        boundForgeRepositoryFromURL(`${origin}/factory/repo.git`, {
          apiURL,
          publicURL,
          owner: "factory",
        }),
      ).toEqual({ owner: "factory", name: "repo" });
});

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
