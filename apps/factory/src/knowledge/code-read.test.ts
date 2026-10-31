import { expect, test } from "bun:test";
import {
  findReadableCodePaths,
  maximumReadableCodeBytes,
  readableCodePath,
  readCodePage,
} from "./code-read";

test("Planning can discover the root System Contract without exposing Factory private files", () => {
  const paths = [
    ".factory/system.json",
    ".factory/assignment.json",
    ".factory/cache/system.json",
    ".factory/system.json/private.json",
    ".factory/credentials.json",
    "nested/.factory/system.json",
    ".factory/../system.json",
    "/.factory/system.json",
    ".env",
  ];
  expect(readableCodePath(".factory/system.json")).toBe(true);
  for (const path of paths.slice(1)) expect(readableCodePath(path)).toBe(false);
  expect(
    findReadableCodePaths(
      paths.map((path) => ({ path, size: 100 })),
      "system.json",
    ),
  ).toEqual({ paths: [".factory/system.json"], truncated: false });
});

test("Planning discovers large lockfiles and extensionless container recipes", () => {
  const files = [
    { path: "pnpm-lock.yaml", size: 415080 },
    { path: ".devcontainer/Dockerfile", size: 1415 },
  ];
  expect(findReadableCodePaths(files, "pnpm-lock.yaml .devcontainer/Dockerfile")).toEqual({
    paths: files.map((file) => file.path),
    truncated: false,
  });
  for (const path of ["Dockerfile", "deploy/Dockerfile.worker", ".devcontainer/Containerfile"])
    expect(readableCodePath(path)).toBe(true);
  for (const path of [
    ".factory/Dockerfile",
    "nested/.factory/Dockerfile",
    "node_modules/Dockerfile",
    "secrets/Dockerfile.private-key",
    "../Dockerfile",
  ])
    expect(readableCodePath(path)).toBe(false);
});

test("a truncated configuration gives Planning the exact next unread line", () => {
  const content = Array.from({ length: 205 }, (_, index) =>
    index === 180 ? "watch: { ignored: ['**/.pnpm-store/**'] }" : `configuration ${index + 1}`,
  ).join("\n");
  const first = readCodePage(content, { startLine: 1, lineCount: 80 });
  expect(first).toMatchObject({ truncated: true, nextStartLine: 81, totalLines: 205 });
  const second = readCodePage(content, { startLine: 81, lineCount: 80 });
  expect(second).toMatchObject({ truncated: true, nextStartLine: 161, totalLines: 205 });
  const last = readCodePage(content, { startLine: 161, lineCount: 80 });
  expect(last).toMatchObject({ truncated: false, nextStartLine: null, totalLines: 205 });
  expect(last.body).toContain("181: watch: { ignored: ['**/.pnpm-store/**'] }");
});

test("a full text page resumes before the first omitted line, without clipping source", () => {
  const content = Array.from({ length: 160 }, (_, index) => `${index + 1}-${"x".repeat(300)}`).join(
    "\n",
  );
  const first = readCodePage(content, { startLine: 1, lineCount: 160 });
  const completeLines = first.body.split("\n");
  expect(completeLines.every((line) => /x{300}$/.test(line))).toBe(true);
  expect(first.body.length).toBeLessThanOrEqual(16000);
  expect(first).toMatchObject({ nextStartLine: completeLines.length + 1 });
  const second = readCodePage(content, {
    startLine: completeLines.length + 1,
    lineCount: 160,
  });
  expect(second.body.split("\n")[0]).toBe(
    `${completeLines.length + 1}: ${completeLines.length + 1}-${"x".repeat(300)}`,
  );
});

test("an oversized single line is explicit, never a partial line or repeated cursor", () => {
  expect(() => readCodePage("x".repeat(16000), { startLine: 1, lineCount: 1 })).toThrow(
    "Code line 1 exceeds the readable page size",
  );
  expect(readCodePage("last line", { startLine: 2, lineCount: 80 })).toEqual({
    body: "",
    truncated: false,
    nextStartLine: null,
    totalLines: 1,
  });
});

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
        { path: "src/large.ts", size: maximumReadableCodeBytes + 1 },
        { path: "node_modules/private.ts", size: 100 },
      ],
      "src private",
    ),
  ).toEqual({ paths: [], truncated: false });
});
