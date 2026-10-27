import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { createStaticAssets } from "./static-assets";
import { fixtureValue } from "../../../test/fixtures/value";

test("built public assets negotiate compression and immutable caching without caching the shell", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "factory-static-"));
  try {
    await mkdir(`${root}/assets`);
    await mkdir(`${root}/.vite`);
    const code = "console.log('owned asset');".repeat(100);
    const asset = "assets/app-fixture1.js";
    await writeFile(`${root}/${asset}`, code);
    await writeFile(`${root}/${asset}.br`, brotliCompressSync(code));
    await writeFile(`${root}/${asset}.gz`, gzipSync(code));
    await writeFile(`${root}/.vite/manifest.json`, "private build metadata");
    const serve = createStaticAssets(
      root,
      async (request) =>
        new Response(request.method === "HEAD" ? null : "<html>owned Start shell</html>", {
          headers: { "cache-control": "no-store" },
        }),
    );
    const get = (path: string, headers?: HeadersInit, method = "GET") =>
      serve(
        new Request(`http://factory.test/${path}`, { method, ...(headers ? { headers } : {}) }),
      );
    const br = await get(asset, { "accept-encoding": "br, gzip" });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toContain("javascript");
    expect(br.headers.get("cache-control")).toContain("immutable");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(brotliDecompressSync(await br.arrayBuffer()).toString()).toBe(code);
    const gzip = await get(asset, { "accept-encoding": "br;q=0, gzip;q=1" });
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(await gzip.arrayBuffer()).toString()).toBe(code);
    const plain = await get(asset, { "accept-encoding": "br;q=0, gzip;q=0" });
    expect(plain.headers.has("content-encoding")).toBe(false);
    expect(await plain.text()).toBe(code);
    expect(
      (
        await get(asset, {
          "if-none-match": fixtureValue(plain.headers.get("etag"), 'plain.headers.get("etag")'),
        })
      ).status,
    ).toBe(304);
    expect((await get(asset, undefined, "HEAD")).body).toBeNull();
    expect((await get("", undefined)).headers.get("cache-control")).toBe("no-store");
    expect((await get("settings", { accept: "text/html" })).headers.get("cache-control")).toBe(
      "no-store",
    );
    for (const path of [".vite/manifest.json", "assets/missing.js", `${asset}.br`, "%00"])
      expect((await get(path)).status).toBe(404);
    expect((await get(asset, undefined, "POST")).status).toBe(405);
    expect((await get(asset, { "accept-encoding": "*;q=0" })).status).toBe(406);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Start renders resource navigation but never missing assets, source or protocol requests", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "factory-start-pages-"));
  const paths: string[] = [];
  try {
    const serve = createStaticAssets(root, async (request) => {
      paths.push(new URL(request.url).pathname);
      return new Response(request.method === "HEAD" ? null : "Start document", {
        headers: { "cache-control": "no-store" },
      });
    });
    for (const path of ["/", "/projects/owned/tickets/owned", "/missing"]) {
      const response = await serve(
        new Request(`http://factory.test${path}`, {
          headers: { accept: "text/html" },
        }),
      );
      expect(await response.text()).toBe("Start document");
    }
    expect(paths).toHaveLength(3);
    for (const path of [
      "/api/missing",
      "/internal/missing",
      "/_server/missing",
      "/src/missing",
      "/assets/missing",
      "/assets/old.js",
      "/.vite/manifest.json",
    ]) {
      const response = await serve(
        new Request(`http://factory.test${path}`, {
          headers: { accept: "text/html" },
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(paths).toHaveLength(3);
    expect(
      (await serve(new Request("http://factory.test/projects/owned", { method: "POST" }))).status,
    ).toBe(405);
    expect((await serve(new Request("http://factory.test/projects/owned"))).status).toBe(404);
    expect((await serve(new Request("http://factory.test/", { method: "HEAD" }))).body).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
