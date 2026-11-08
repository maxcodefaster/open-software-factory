import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { frameworkVex, verifyFrameworkFiles } from "./framework-image-proof";

const patchedVersion = "1.169.26";

test("Factory and the Starter pin the patched server-function transport", async () => {
  const [factory, starter, lock] = await Promise.all([
    Bun.file("package.json").json(),
    Bun.file("templates/starter-app/package.json").json(),
    Bun.file("templates/starter-app/package-lock.json").json(),
  ]);
  const patchPath = factory.patchedDependencies[`@tanstack/start-server-core@${patchedVersion}`];
  expect(patchPath).toBe("patches/tanstack-start-server-core-security.patch");
  expect(starter.scripts.postinstall).toBe("node .factory/apply-framework-security.mjs");
  const patch = await Bun.file("templates/starter-app/.factory/framework-security.json").json();
  expect(patch.version).toBe(patchedVersion);
  expect(patch.cve).toBe("CVE-2026-102989");
  expect(
    createHash("sha256")
      .update(new Uint8Array(await Bun.file(patchPath).arrayBuffer()))
      .digest("hex"),
  ).toBe(patch.patchSHA256);
  const start = createRequire(import.meta.resolve("@tanstack/solid-start/package.json"));
  expect(
    (await Bun.file(start.resolve("@tanstack/start-server-core/package.json")).json()).version,
  ).toBe(patchedVersion);
  const directory = dirname(start.resolve("@tanstack/start-server-core/package.json"));
  expect(patch.files).toHaveLength(4);
  for (const file of patch.files) {
    const digest = createHash("sha256")
      .update(new Uint8Array(await Bun.file(join(directory, file.path)).arrayBuffer()))
      .digest("hex");
    expect(digest).toBe(file.afterSHA256);
  }
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith("node_modules/@tanstack/start-server-core"),
  );
  expect(copies).toHaveLength(1);
  for (const [, value] of copies)
    expect((value as { version: string }).version).toBe(patchedVersion);
});

test("Starter postinstall is idempotent and refuses unknown files without partial writes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "factory-framework-postinstall-"));
  const start = createRequire(import.meta.resolve("@tanstack/solid-start/package.json"));
  const directory = dirname(start.resolve("@tanstack/start-server-core/package.json"));
  const target = join(temporary, "node_modules/@tanstack/start-server-core");
  const patch = await Bun.file("templates/starter-app/.factory/framework-security.json").json();
  try {
    await cp("templates/starter-app/.factory", join(temporary, ".factory"), { recursive: true });
    await cp(directory, target, { recursive: true });
    await mkdir(join(temporary, "node_modules/@tanstack/solid-start"), { recursive: true });
    await writeFile(
      join(temporary, "node_modules/@tanstack/solid-start/package.json"),
      JSON.stringify({ name: "@tanstack/solid-start" }),
    );
    const run = async () => {
      const child = Bun.spawn(["node", ".factory/apply-framework-security.mjs"], {
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
    const [success, stdout, stderr] = await run();
    expect(success).toBe(0);
    expect(stdout).toContain("Framework security backport applied");
    expect(stderr).toBe("");
    expect(await verifyFrameworkFiles(target, patch)).toHaveLength(4);
    const changed = join(target, patch.files.at(-1).path);
    await writeFile(changed, `${await readFile(changed, "utf8")}\n// Unknown upstream change\n`);
    const before = await Promise.all(
      patch.files.map((file: { path: string }) => readFile(join(target, file.path), "utf8")),
    );
    const [failure, rejectedOutput, rejectedError] = await run();
    expect(failure).toBe(1);
    expect(rejectedOutput).toBe("");
    expect(rejectedError).toContain("Framework file changed");
    const after = await Promise.all(
      patch.files.map((file: { path: string }) => readFile(join(target, file.path), "utf8")),
    );
    expect(after).toEqual(before);
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

test("image verification rejects an original file before creating a VEX", async () => {
  const start = createRequire(import.meta.resolve("@tanstack/solid-start/package.json"));
  const directory = dirname(start.resolve("@tanstack/start-server-core/package.json"));
  const patch = await Bun.file("templates/starter-app/.factory/framework-security.json").json();
  expect(await verifyFrameworkFiles(directory, patch)).toHaveLength(4);
  const unpatched = structuredClone(patch);
  unpatched.files[0].afterSHA256 = unpatched.files[0].beforeSHA256;
  await expect(verifyFrameworkFiles(directory, unpatched)).rejects.toThrow(
    "Unpatched framework file",
  );
});

test("the VEX covers one CVE in one package version in one immutable image", async () => {
  const patch = await Bun.file("templates/starter-app/.factory/framework-security.json").json();
  const image = `ghcr.io/maxcodefaster/open-software-factory/factory@sha256:${"a".repeat(64)}`;
  const vex = frameworkVex(image, patch);
  expect(vex.statements).toHaveLength(1);
  expect(vex.statements[0]).toMatchObject({
    vulnerability: { name: "CVE-2026-102989" },
    status: "fixed",
    products: [
      {
        "@id": `pkg:oci/factory@sha256:${"a".repeat(64)}?repository_url=ghcr.io%2Fmaxcodefaster%2Fopen-software-factory%2Ffactory`,
        subcomponents: [{ "@id": "pkg:npm/%40tanstack/start-server-core@1.169.26" }],
      },
    ],
  });
  expect(() =>
    frameworkVex("ghcr.io/maxcodefaster/open-software-factory/factory:latest", patch),
  ).toThrow("immutable image reference");
});
