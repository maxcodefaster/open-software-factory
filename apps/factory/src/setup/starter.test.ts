import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import upstream from "../../../../upstream.json";
import { starterFiles } from "./starter";

test("the authored Starter uses the selected exact toolchain and database images", async () => {
  const files = await starterFiles();
  const content = (path: string) => {
    const file = files.find((file) => file.path === path);
    if (!file) throw new Error(`Starter file missing: ${path}`);
    return file.content;
  };
  const manifest = JSON.parse(content("package.json"));
  const compose = parse(content(".devcontainer/compose.yaml"));
  const local = parse(
    await readFile(new URL("../../../../deploy/local/compose.yaml", import.meta.url), "utf8"),
  );
  expect(manifest.engines.node).toBe(upstream.nodeDevelopment.version);
  for (const name of ["solid-js", "@solidjs/web"]) {
    expect(manifest.dependencies[name]).toBe("2.0.0-rc.18");
    expect(manifest.dependencies[name]).not.toMatch(/^[~^*]/);
  }
  expect(manifest.devDependencies["@solidjs/vite-plugin"]).toBe("3.0.0-next.51");
  for (const name of ["@tanstack/solid-router", "@tanstack/solid-start"])
    expect(manifest.dependencies[name]).toBe("2.0.0-rc.9");
  for (const name of ["@solidjs/compiler", "@solidjs/signals", "@solidjs/babel-plugin"])
    expect(manifest.overrides[name]).toBe(manifest.dependencies["solid-js"]);
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
