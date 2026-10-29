import { expect, test } from "bun:test";
import { findReadableCodePaths } from "./code-read";

test("a real multi-target Planning query finds the CLI, README and related tests", () => {
  const files = [
    "README.md",
    "apps/forms-admin/README.md",
    "tools/workspace.mjs",
    "test/workspace.test.mjs",
    ".env.example",
    "credentials.json",
    ".factory/system.json",
  ].map((path) => ({ path, size: 100 }));
  const result = findReadableCodePaths(files, "tools/workspace.mjs README workspace tests");
  expect(result.paths[0]).toBe("tools/workspace.mjs");
  expect(result.paths).toContain("README.md");
  expect(result.paths).toContain("test/workspace.test.mjs");
  expect(result.paths).not.toContain(".env.example");
  expect(result.paths).not.toContain("credentials.json");
  expect(result.paths).not.toContain(".factory/system.json");
});

test("path discovery stays bounded and does not expose oversized or protected files", () => {
  const files = Array.from({ length: 41 }, (_, index) => ({
    path: `src/module-${index}.ts`,
    size: 100,
  }));
  expect(findReadableCodePaths(files, "")).toEqual({
    paths: files.slice(0, 40).map((file) => file.path),
    truncated: true,
  });
  expect(
    findReadableCodePaths(
      [
        { path: "src/credentials.ts", size: 100 },
        { path: "src/large.ts", size: 250001 },
        { path: "node_modules/private.ts", size: 100 },
      ],
      "src private",
    ),
  ).toEqual({ paths: [], truncated: false });
});
