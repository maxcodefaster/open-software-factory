import { expect, test } from "bun:test";
import { applicationFixPath } from "./autofix";

test("Autofix only admits application source and its tests, never operational configuration", () => {
  for (const path of [
    "src/invoice.ts",
    "apps/web/src/App.tsx",
    "test/invoice.test.ts",
    "api/handler.py",
    "src/main.go",
  ])
    expect(applicationFixPath(path), path).toBe(true);
  for (const path of [
    "../src/invoice.ts",
    "/src/invoice.ts",
    "src\\invoice.ts",
    ".forgejo/workflows/check.yml",
    ".github/actions/build.ts",
    "infra/main.tf",
    "deploy/handler.ts",
    "scripts/build.ts",
    "AGENTS.md",
    "src/AGENTS.md",
    "docs/SKILL.md",
    "package.json",
    "bun.lock",
    "src/credentials.ts",
    "secrets/read.ts",
    "migrations/001.sql",
    "vite.config.ts",
    "test/setup.ts",
    ".devcontainer/devcontainer.json",
    "src/auth-policy.ts",
  ])
    expect(applicationFixPath(path), path).toBe(false);
});
