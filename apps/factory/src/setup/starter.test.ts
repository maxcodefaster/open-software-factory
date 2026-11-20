import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import upstream from "../../../../upstream.json";
import { starterFiles } from "./starter";

test("Starter runtime-generated Feature lockfiles stay out of ordinary Git changes, while tracked metadata is retained", async () => {
  const files = await starterFiles();
  const ignore = files.find((file) => file.path === ".gitignore");
  if (!ignore) throw new Error("Authored Starter ignore rules are missing");
  const directory = await mkdtemp(join(tmpdir(), "factory-starter-lockfile-"));
  const lockfile = ".devcontainer/devcontainer-lock.json";
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error("Owned Starter Git fixture failed");
    return text;
  };
  try {
    await writeFile(join(directory, ".gitignore"), ignore.content);
    await mkdir(join(directory, ".devcontainer"));
    await writeFile(join(directory, lockfile), '{"features":{}}\n');
    await writeFile(join(directory, ".devcontainer/devcontainer.json"), '{"image":"owned"}\n');
    await git("init", "--initial-branch=main");
    await git("add", "--all");
    expect((await git("ls-files")).split("\n")).not.toContain(lockfile);
    expect((await git("ls-files")).split("\n")).toContain(".devcontainer/devcontainer.json");
    await git("add", "--force", lockfile);
    expect((await git("ls-files")).split("\n")).toContain(lockfile);
    expect(await readFile(join(directory, lockfile), "utf8")).toBe('{"features":{}}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the authored Starter uses the selected exact toolchain and database images", async () => {
  const files = await starterFiles();
  const content = (path: string) => {
    const file = files.find((file) => file.path === path);
    if (!file) throw new Error(`Starter file missing: ${path}`);
    return file.content;
  };
  const manifest = JSON.parse(content("package.json"));
  const factory = await Bun.file(new URL("../../../../package.json", import.meta.url)).json();
  const compose = parse(content(".devcontainer/compose.yaml"));
  const local = parse(
    await readFile(new URL("../../../../deploy/local/compose.yaml", import.meta.url), "utf8"),
  );
  expect(manifest.engines.node).toBe(upstream.nodeDevelopment.version);
  for (const name of ["solid-js", "@solidjs/web"]) {
    expect(manifest.dependencies[name]).toBe(factory.dependencies[name]);
    expect(manifest.dependencies[name]).toMatch(/^2\.\d+\.\d+$/);
  }
  expect(manifest.devDependencies["@solidjs/vite-plugin"]).toBe(
    factory.devDependencies["@solidjs/vite-plugin"],
  );
  expect(manifest.devDependencies["@solidjs/vite-plugin"]).toMatch(/^3\.\d+\.\d+$/);
  for (const name of ["@tanstack/solid-router", "@tanstack/solid-start"])
    expect(manifest.dependencies[name]).toBe(factory.dependencies[name]);
  for (const name of ["@solidjs/compiler", "@solidjs/signals", "@solidjs/babel-plugin"]) {
    expect(manifest.overrides[name]).toBe(factory.overrides[name]);
    expect(manifest.overrides[name]).toMatch(/^2\.\d+\.\d+$/);
  }
  const lock = JSON.parse(content("package-lock.json"));
  expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
  expect(lock.packages[""].devDependencies).toEqual(manifest.devDependencies);
  expect(
    files.some((file) => /(^|\/)(node_modules|dist|\.output|\.tanstack)\//.test(file.path)),
  ).toBe(false);
  expect(files.some((file) => /(^|\/)\.env/.test(file.path))).toBe(false);
  expect(compose.services.app.image).toBe(upstream.nodeDevelopment.image);
  expect(compose.services.postgres.image).toBe(local.services.postgres.image);
});
