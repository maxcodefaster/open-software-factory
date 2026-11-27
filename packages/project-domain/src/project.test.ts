import { describe, expect, test } from "bun:test";
import { createRegisterProjectInput, registerProjectInput } from "./project";

describe("Project registration", () => {
  test("accepts the configured isolated repository origin", () => {
    expect(
      createRegisterProjectInput("http://127.0.0.1:63653").safeParse({
        slug: "release-proof",
        name: "Release proof",
        repositoryUrl: "http://127.0.0.1:63653/factory/runtime-fixture.git",
        defaultBranch: "main",
        actorTemplatePath: ".factory/actor-template.json",
      }).success,
    ).toBe(true);
  });

  test.each([
    "http://127.0.0.1:33030/factory/project.git",
    "http://127.0.0.1:63654/factory/project.git",
    "http://localhost:63653/factory/project.git",
    "http://token@127.0.0.1:63653/factory/project.git",
    "http://127.0.0.1:63653.evil.example/factory/project.git",
  ])("rejects unconfigured or credential-bearing origin %s", (repositoryUrl) => {
    expect(
      createRegisterProjectInput("http://127.0.0.1:63653").safeParse({
        slug: "release-proof",
        name: "Release proof",
        repositoryUrl,
        defaultBranch: "main",
        actorTemplatePath: ".factory/actor-template.json",
      }).success,
    ).toBe(false);
  });

  test("does not allow a local HTTP origin without installation configuration", () => {
    expect(
      registerProjectInput.safeParse({
        slug: "release-proof",
        name: "Release proof",
        repositoryUrl: "http://127.0.0.1:33030/factory/project.git",
        defaultBranch: "main",
        actorTemplatePath: ".factory/actor-template.json",
      }).success,
    ).toBe(false);
  });

  test("accepts the native ActorTemplate repository path", () => {
    expect(
      registerProjectInput.parse({
        slug: "runtime-fixture",
        name: "Runtime fixture",
        repositoryUrl: "file:///workspace/test/fixtures/runtime-project",
        defaultBranch: "main",
        actorTemplatePath: ".factory/actor-template.json",
      }).actorTemplatePath,
    ).toBe(".factory/actor-template.json");
  });

  test("trims the ActorTemplate repository path", () => {
    expect(
      registerProjectInput.parse({
        slug: "runtime-fixture",
        name: "Runtime fixture",
        repositoryUrl: "https://example.com/project.git",
        defaultBranch: "main",
        actorTemplatePath: " .factory/actor-template.json ",
      }).actorTemplatePath,
    ).toBe(".factory/actor-template.json");
  });

  test.each([
    "",
    " ",
    "..",
    "../actor-template.json",
    ".factory/../actor-template.json",
    ".factory/../../actor-template.json",
    ".factory/..",
    "/.factory/actor-template.json",
    " /.factory/actor-template.json ",
    "//example.com/actor-template.json",
    "a".repeat(501),
  ])("rejects unsafe or invalid ActorTemplate repository path %s", (actorTemplatePath) => {
    expect(
      registerProjectInput.safeParse({
        slug: "runtime-fixture",
        name: "Runtime fixture",
        repositoryUrl: "https://example.com/project.git",
        defaultBranch: "main",
        actorTemplatePath,
      }).success,
    ).toBe(false);
  });

  test.each([
    ["alone", { devcontainerPath: ".devcontainer/devcontainer.json" }],
    [
      "alongside actorTemplatePath",
      {
        actorTemplatePath: ".factory/actor-template.json",
        devcontainerPath: ".devcontainer/devcontainer.json",
      },
    ],
  ])("rejects obsolete devcontainerPath %s as an unknown key", (_, fields) => {
    for (const input of [
      registerProjectInput,
      createRegisterProjectInput("http://127.0.0.1:63653"),
    ]) {
      const result = input.safeParse({
        slug: "runtime-fixture",
        name: "Runtime fixture",
        repositoryUrl: "https://example.com/project.git",
        defaultBranch: "main",
        ...fields,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({ code: "unrecognized_keys", keys: ["devcontainerPath"] }),
      );
    }
  });

  test.each([
    ["embedded credentials", { repositoryUrl: "https://token@example.com/project.git" }],
    ["invalid branch", { defaultBranch: "../main" }],
  ])("rejects %s", (_, replacement) => {
    const result = registerProjectInput.safeParse({
      slug: "runtime-fixture",
      name: "Runtime fixture",
      repositoryUrl: "https://example.com/project.git",
      defaultBranch: "main",
      actorTemplatePath: ".factory/actor-template.json",
      ...replacement,
    });
    expect(result.success).toBe(false);
  });
});
