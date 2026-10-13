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
  expect(compose.services.app.image).toBe(upstream.nodeDevelopment.image);
  expect(compose.services.postgres.image).toBe(local.services.postgres.image);
});
