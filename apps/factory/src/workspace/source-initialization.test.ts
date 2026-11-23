import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InitialSourceSeed, materializeInitialSource } from "./source-initialization";

test("initial Source recovery preserves edited canonical files without running Git again", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-initial-source-"));
  const seed: InitialSourceSeed = {
    version: 1,
    id: crypto.randomUUID(),
    workspaceID: crypto.randomUUID(),
    projectID: crypto.randomUUID(),
    repositoryURL: "https://forge.test/owned/repository.git",
    revision: "a".repeat(40),
    branch: "main",
  };
  const base = join(root, seed.workspaceID, seed.id);
  try {
    await mkdir(join(base, "project"), { recursive: true });
    await writeFile(join(base, "initial-source.json"), JSON.stringify(seed));
    await writeFile(join(base, "project", "edited.txt"), "saved before first compute\n");
    // Both confirmed recovery and a lost DB confirmation read the same tree.
    for (const confirmed of [true, false]) {
      await materializeInitialSource("/must-not-execute", root, seed, confirmed);
      expect(await readFile(join(base, "project", "edited.txt"), "utf8")).toBe(
        "saved before first compute\n",
      );
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test.each(["missing-tree", "missing-marker", "foreign-marker", "symlink-project"] as const)(
  "initial Source never replaces retained or foreign data: %s",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "factory-initial-source-refusal-"));
    const seed: InitialSourceSeed = {
      version: 1,
      id: crypto.randomUUID(),
      workspaceID: crypto.randomUUID(),
      projectID: crypto.randomUUID(),
      repositoryURL: "https://forge.test/owned/repository.git",
      revision: "b".repeat(40),
      branch: "main",
    };
    const base = join(root, seed.workspaceID, seed.id);
    try {
      if (failure !== "missing-tree") {
        await mkdir(base, { recursive: true });
        if (failure === "symlink-project") await symlink(root, join(base, "project"));
        else await mkdir(join(base, "project"));
        if (failure !== "missing-marker")
          await writeFile(
            join(base, "initial-source.json"),
            JSON.stringify({
              ...seed,
              ...(failure === "foreign-marker" ? { projectID: crypto.randomUUID() } : {}),
            }),
          );
      }
      await expect(
        materializeInitialSource("/must-not-execute", root, seed, true),
      ).rejects.toThrow();
      if (failure === "missing-marker")
        await expect(
          materializeInitialSource("/must-not-execute", root, seed, false),
        ).rejects.toThrow("Unconfirmed existing Source was preserved");
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
