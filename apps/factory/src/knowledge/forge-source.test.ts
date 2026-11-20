import { expect, test } from "bun:test";
import {
  forgeBinding,
  forgeRepositoryBindingMatrix,
} from "../../../../test/support/forge-repository-binding";
import { factoryForgeSource } from "./forge-source";

test("Wiki sources stay on the configured Forgejo origin and owner", () => {
  expect(
    factoryForgeSource(
      "https://forge.example/factory/app.git",
      "https://forge.example/api/v1/",
      "factory",
    ),
  ).toEqual({ owner: "factory", name: "app" });
  for (const source of [
    "https://other.example/factory/app.git",
    "https://forge.example/other/app.git",
    "file:///factory/app.git",
    "https://user:secret@forge.example/factory/app.git",
    "https://forge.example/factory/app.git?ref=main",
    "https://forge.example/nested/factory/app.git",
  ])
    expect(() => factoryForgeSource(source, "https://forge.example/api/v1/", "factory")).toThrow(
      "configured Factory Forgejo",
    );
});

test("Factory source identity accepts only the configured public Forge or private API origin", () => {
  const api = "http://forge-control.native.test:3000/api/v1/";
  const publicURL = "https://git.native.test";
  for (const source of [
    "https://git.native.test/owned/repo.git",
    "https://git.native.test/owned/repo",
    "http://forge-control.native.test:3000/owned/repo.git",
  ])
    expect(factoryForgeSource(source, api, "owned", publicURL)).toEqual({
      owner: "owned",
      name: "repo",
    });
  for (const source of [
    "https://foreign.native.test/owned/repo.git",
    "http://git.native.test/owned/repo.git",
    "https://git.native.test:444/owned/repo.git",
    "https://git.native.test/foreign/repo.git",
    "https://owned:credential@git.native.test/owned/repo.git",
    "https://git.native.test/owned/repo.git?ref=main",
    "https://git.native.test/owned/repo.git#source",
    "https://git.native.test/nested/owned/repo.git",
    "https://git.native.test/owned/repo%2fother.git",
    "https://git.native.test//owned/repo.git",
    "https://git.native.test/owned/repo.git/",
    "file:///owned/repo.git",
  ])
    expect(() => factoryForgeSource(source, api, "owned", publicURL)).toThrow(
      "configured Factory Forgejo",
    );
});

test("Source consumes the shared binding matrix and retains forbidden errors", () => {
  const { accepted, malformed } = forgeRepositoryBindingMatrix();
  const source = (url: string) =>
    factoryForgeSource(url, forgeBinding.apiURL, forgeBinding.owner, forgeBinding.publicURL);
  for (const { url, repository } of accepted) expect(source(url)).toEqual(repository);
  for (const url of malformed)
    expect(() => source(url)).toThrow(
      expect.objectContaining({ code: "forbidden", message: expect.stringContaining("Forgejo") }),
    );
});
