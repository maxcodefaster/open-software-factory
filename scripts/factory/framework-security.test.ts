import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { verifyFrameworkVersion } from "./framework-image-proof";

const fixedVersion = "1.169.45";

test("document packages stay aligned and reader/editor share the qualified parser versions", async () => {
  const manifest = await Bun.file("package.json").json();
  const lock = parse(await Bun.file("bun.lock").text()) as {
    packages: Record<string, [string, ...unknown[]]>;
  };
  const tiptapVersions = Object.entries(manifest.dependencies)
    .filter(([name]) => name.startsWith("@tiptap/"))
    .map(([, version]) => version);
  expect(new Set(tiptapVersions).size).toBe(1);
  for (const name of ["marked", "highlight.js"]) {
    const versions = Object.values(lock.packages)
      .map(([identity]) => identity)
      .filter((identity) => identity.startsWith(`${name}@`));
    expect(versions).toEqual([`${name}@${manifest.dependencies[name]}`]);
  }
  const root = createRequire(import.meta.url);
  for (const [consumer, dependency] of [
    ["@tiptap/markdown", "marked"],
    ["lowlight", "highlight.js"],
  ] as const) {
    const scoped = createRequire(import.meta.resolve(consumer));
    expect(scoped.resolve(dependency)).toBe(root.resolve(dependency));
  }
});

test("Factory and the Starter use the fixed upstream transport with a metadata-only export repair", async () => {
  const [factory, starter, lock] = await Promise.all([
    Bun.file("package.json").json(),
    Bun.file("templates/starter-app/package.json").json(),
    Bun.file("templates/starter-app/package-lock.json").json(),
  ]);
  const patchPath = factory.patchedDependencies[`@tanstack/start-server-core@${fixedVersion}`];
  expect(patchPath).toBe("patches/tanstack-start-server-core-exports.patch");
  const patch = await Bun.file(patchPath).text();
  expect(patch.split("diff --git")).toHaveLength(2);
  expect(patch).toContain("diff --git a/package.json b/package.json");
  expect(starter.scripts.postinstall).toBe("node .factory/repair-framework-export.mjs");
  const start = createRequire(import.meta.resolve("@tanstack/solid-start/package.json"));
  expect(
    (await Bun.file(start.resolve("@tanstack/start-server-core/package.json")).json()).version,
  ).toBe(fixedVersion);
  const directory = dirname(start.resolve("@tanstack/start-server-core/package.json"));
  expect(await verifyFrameworkVersion(directory)).toBe(fixedVersion);
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith("node_modules/@tanstack/start-server-core"),
  );
  expect(copies).toHaveLength(1);
  for (const [, value] of copies) expect((value as { version: string }).version).toBe(fixedVersion);
});

test("Starter export repair is idempotent and refuses unknown metadata without writing", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "factory-framework-exports-"));
  const start = createRequire(import.meta.resolve("@tanstack/solid-start/package.json"));
  const metadata = await readFile(
    start.resolve("@tanstack/start-server-core/package.json"),
    "utf8",
  );
  const target = join(temporary, "node_modules/@tanstack/start-server-core");
  try {
    await cp("templates/starter-app/.factory", join(temporary, ".factory"), { recursive: true });
    await mkdir(target, { recursive: true });
    await mkdir(join(temporary, "node_modules/@tanstack/solid-start"), { recursive: true });
    await writeFile(
      join(temporary, "node_modules/@tanstack/solid-start/package.json"),
      JSON.stringify({ name: "@tanstack/solid-start" }),
    );
    const original = JSON.parse(metadata);
    delete original.exports["./request-scope"];
    await writeFile(join(target, "package.json"), JSON.stringify(original, null, 2));
    const run = async () => {
      const child = Bun.spawn(["node", ".factory/repair-framework-export.mjs"], {
        cwd: temporary,
        stdout: "pipe",
        stderr: "pipe",
      });
      return Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
    };
    for (const _ of [0, 1]) {
      expect(await run()).toEqual([0, "", ""]);
      expect(await readFile(join(target, "package.json"), "utf8")).toBe(metadata);
    }
    const unknown = `${metadata}\n`;
    await writeFile(join(target, "package.json"), unknown);
    const [failure, stdout, stderr] = await run();
    expect(failure).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown TanStack package metadata");
    expect(await readFile(join(target, "package.json"), "utf8")).toBe(unknown);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("image transport qualification rejects vulnerable or unexpected package identities", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "factory-framework-version-"));
  try {
    for (const metadata of [
      { name: "@tanstack/start-server-core", version: "1.169.26" },
      { name: "@tanstack/start-server-core", version: "1.169.45" },
      { name: "another-package", version: fixedVersion },
    ]) {
      await writeFile(join(temporary, "package.json"), JSON.stringify(metadata));
      await expect(verifyFrameworkVersion(temporary)).rejects.toThrow();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("upstream transport accepts public input but discards private middleware fields", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "test/fixtures/framework-transport-security.ts"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  expect(stdout).toContain("discarded private middleware fields");
});
