import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createPageHint } from "./page-hints";

test("page hints preload only the primary Latin variable font", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "factory-hints-"));
  try {
    await mkdir(`${root}/assets`);
    for (const name of [
      "inter-latin-wght-normal-Q1w2E3r4.woff2",
      "inter-latin-ext-wght-normal-Q1w2E3r4.woff2",
      "factory-AbCd1234.js",
    ])
      await writeFile(`${root}/assets/${name}`, "x");
    const hint = createPageHint(root);
    expect(hint).toBe(
      '</assets/inter-latin-wght-normal-Q1w2E3r4.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin',
    );
    expect(createPageHint(resolve(root, "missing"))).toBe(undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
