import { expect, test } from "bun:test";
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
