import { expect, test } from "bun:test";
import { activityNavigation } from "./activity-navigation";

test("activity navigation uses structured tool identities, never guessed output paths or arbitrary source", () => {
  expect(
    activityNavigation(
      "read",
      { path: "/workspace/project/src/app.ts", content: "not exposed" },
      {},
    ),
  ).toEqual({ path: "src/app.ts" });
  expect(
    activityNavigation("edit", { filePath: "src/app.ts" }, { diff: "-before\n+after" }),
  ).toEqual({ path: "src/app.ts", diff: "-before\n+after" });
  for (const path of [
    "/etc/passwd",
    "../secret",
    "src/../secret",
    ".git/config",
    "a//b",
    "a\\b",
    "https://evil.test",
    "src/\nfile",
    ".factory-save-123",
  ])
    expect(activityNavigation("read", { path }, {})).toBeUndefined();
  expect(
    activityNavigation("bash", { command: "cat src/app.ts", path: "src/app.ts" }, {}),
  ).toBeUndefined();
  expect(
    activityNavigation("apply_patch", { patchText: "*** Update File: a" }, {}),
  ).toBeUndefined();
});

test("a shortened recorded diff is labeled and never includes tool input content", () => {
  const target = activityNavigation(
    "write",
    { path: "src/app.ts", content: "private-input" },
    { diff: "+".repeat(64_001) },
  );
  expect(target?.diff?.length).toBe(64_000);
  expect(target?.truncated).toBe(true);
  expect(JSON.stringify(target)).not.toContain("private-input");
});
