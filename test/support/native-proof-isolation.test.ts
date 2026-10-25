import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("the Writer transport proof owns its Forgejo and never administers the retained installation", async () => {
  const source = await readFile("test/support/change-writer-runtime.live.test.ts", "utf8");
  expect(source.includes("local-forgejo-1")).toBe(false);
  expect(source.includes(".factory/forgejo-token")).toBe(false);
  expect(source.includes("127.0.0.1:33030")).toBe(false);
  expect(source.includes("ownedMonitoringForge")).toBe(true);
  expect(source.includes("forgeHost.execute")).toBe(true);
  expect(source.includes("forgeHost.dispose")).toBe(true);
  expect(source.includes("forgeHost.origin")).toBe(true);
});

test("native source proofs use the exact published artifact set, not unpublished build metadata", async () => {
  for (const file of [
    "test/support/workspace-source-lifecycle.live.test.ts",
    "test/support/workspace-source-storage.live.test.ts",
    "test/support/developer-ide-browser.live.test.ts",
  ]) {
    const source = await readFile(file, "utf8");
    expect(source.includes("proof-metadata.json")).toBe(false);
    expect(source.includes("127.0.0.1:33030")).toBe(false);
    expect(source.includes(".factory/forgejo-token")).toBe(false);
    expect(source.includes("publishedRuntimeArtifacts")).toBe(true);
    expect(source.includes('["workspace-files"]')).toBe(true);
  }
});

test("the storage proof stops its canonical source before removing the shared Workspace storage", async () => {
  const source = await readFile("test/support/workspace-source-storage.live.test.ts", "utf8");
  expect(source.includes("kubernetes.deleteNamespace(")).toBe(false);
  expect(source.includes("removeOwnedProjectSources(database, projectID")).toBe(true);
  expect(source.includes('"stopWorkspaceSource"')).toBe(true);
});

test("owned UI hosts and compiled-function browser runners disable implicit workspace dotenv loading", async () => {
  for (const file of [
    "test/browser/mcp-library.spec.ts",
    "test/browser/monitoring-settings.spec.ts",
    "test/browser/skill-settings.spec.ts",
    "test/browser/project-backgrounds.spec.ts",
  ]) {
    const source = await readFile(file, "utf8");
    expect(/"bun",\s*"--no-env-file",\s*"test\/fixtures\/skill-browser-host.ts"/.test(source)).toBe(
      true,
    );
  }
  for (const file of [
    "test/integration/server-function-attachments.test.ts",
    "test/integration/server-function-library-ui.test.ts",
    "test/integration/server-function-ui-fixtures.test.ts",
    "test/integration/server-function-workspaces.test.ts",
    "test/integration/server-functions.test.ts",
  ]) {
    const source = await readFile(file, "utf8");
    expect(
      /process.execPath,\s*"--no-env-file",\s*"node_modules\/@playwright\/test\/cli.js"/.test(
        source,
      ),
    ).toBe(true);
  }
});
