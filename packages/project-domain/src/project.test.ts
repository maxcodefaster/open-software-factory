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
        devcontainerPath: ".devcontainer/devcontainer.json",
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
        devcontainerPath: ".devcontainer/devcontainer.json",
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
        devcontainerPath: ".devcontainer/devcontainer.json",
      }).success,
    ).toBe(false);
  });

  test("accepts the maintained fixture", () => {
    expect(
      registerProjectInput.parse({
        slug: "runtime-fixture",
        name: "Runtime fixture",
        repositoryUrl: "file:///workspace/test/fixtures/runtime-project",
        defaultBranch: "main",
        devcontainerPath: ".devcontainer/devcontainer.json",
      }),
    ).toBeDefined();
  });

  test.each([
    ["embedded credentials", { repositoryUrl: "https://token@example.com/project.git" }],
    ["repository path traversal", { devcontainerPath: "../devcontainer.json" }],
    ["invalid branch", { defaultBranch: "../main" }],
  ])("rejects %s", (_, replacement) => {
    const result = registerProjectInput.safeParse({
      slug: "runtime-fixture",
      name: "Runtime fixture",
      repositoryUrl: "https://example.com/project.git",
      defaultBranch: "main",
      devcontainerPath: ".devcontainer/devcontainer.json",
      ...replacement,
    });
    expect(result.success).toBe(false);
  });
});
