import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { startApplication } from "./application.ts";

test("Start streams scoped HTML and Nitro serves only public production assets", async () => {
  const application = await startApplication();
  const prefix = "/runtime/01994a7d-0000-7000-8000-000000000001/preview/app";
  const headers = {
    "x-forwarded-host": "01994a7d000070008000000000000001-app.runtime.localhost:58000",
    "x-forwarded-proto": "http",
    "x-forwarded-prefix": prefix,
  };
  try {
    const page = await fetch(application.base, { headers });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.ok(html.includes(`<base href="${prefix}/">`));
    assert.ok(html.includes("Welcome back"), "The session view must render on the server");
    assert.ok(!html.includes("@vite/client"));
    const script = html.match(new RegExp(`src="${prefix}/(assets/[^"]+\\.js)"`))?.[1];
    assert.ok(script, "Start must emit a scoped browser entry");
    const asset = await fetch(`${application.base}/${script}`, { headers });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const directory = new URL("../.output/public/assets/", import.meta.url);
    const chunks = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(new URL(name, directory), "utf8")),
    );
    const source = chunks.join("\n");
    for (const privateCode of [
      "Set a strong BETTER_AUTH_SECRET in environment settings",
      "Set DATABASE_URL in your environment settings",
      "Too many auth origins",
      process.env.BETTER_AUTH_SECRET,
    ])
      if (privateCode)
        assert.ok(!source.includes(privateCode), "Server-only code reached the browser");
    assert.equal(await (await fetch(application.base, { method: "HEAD" })).text(), "");
    for (const path of [
      "/src/auth.ts",
      "/.output/server/index.mjs",
      "/assets/%2e%2e/package.json",
      "/assets/not-found.js",
    ])
      assert.equal((await fetch(application.base + path, { headers })).status, 404);
  } finally {
    await application.close();
  }
});
