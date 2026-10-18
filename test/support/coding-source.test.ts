import { expect, test } from "bun:test";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { verifyCodingSource } from "../fixtures/coding-source";

const preserved = [
  "package.json",
  "package-lock.json",
  ".devcontainer/devcontainer.json",
  ".devcontainer/compose.yaml",
  ".factory/system.json",
  ".forgejo/workflows/factory-verification.yml",
  "src/server.ts",
  "src/auth.ts",
  "drizzle/0000_auth.sql",
].map((path) => ({ path, sha: "a".repeat(40), size: 1 }));
const regression = { path: "test/checklist.test.ts", sha: "b".repeat(40), size: 1 };

function fixture(after = [...preserved, regression]) {
  return {
    forge: {
      listFiles: async (_repository: unknown, revision: string) =>
        revision === "base" ? preserved : after,
    } as unknown as ReturnType<typeof createForgejoClient>,
    repository: { owner: "owned", name: "fixture" },
    baseSHA: "base",
    commitSHA: "change",
  };
}

test("coding acceptance requires real regression changes and preserves explicit non-goals", async () => {
  expect((await verifyCodingSource(fixture())).changedTests).toEqual([regression.path]);
  await expect(verifyCodingSource(fixture(preserved))).rejects.toThrow("regression tests");
});

test.each(["changed", "deleted"])(
  "coding acceptance rejects %s dependency configuration",
  async (boundary) => {
    const after =
      boundary === "deleted"
        ? [...preserved.slice(1), regression]
        : [
            ...preserved.map((file) =>
              file.path === "package.json" ? { ...file, sha: "c".repeat(40) } : file,
            ),
            regression,
          ];
    await expect(verifyCodingSource(fixture(after))).rejects.toThrow("package.json");
  },
);
