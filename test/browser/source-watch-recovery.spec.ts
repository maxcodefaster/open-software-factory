import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";

async function sourceWatchFixture(rootStatus = 200) {
  const built = await Bun.build({
    entrypoints: [
      `${import.meta.dirname}/../../deploy/theia-ide/factory-ide-extension/src/browser/factory-source-client.ts`,
    ],
    target: "browser",
  });
  const output = built.outputs[0];
  if (!built.success || built.outputs.length !== 1 || !output)
    throw new Error("Owned Source client browser build failed");
  const client = await output.text();
  const observed = { streams: 0, rootReads: 0, writes: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/source-client.js")
        return new Response(client, { headers: { "content-type": "text/javascript" } });
      if (path === "/editor/")
        return new Response(
          `<!doctype html><html lang="en"><title>Source watch recovery fixture</title>
<h1>Source watch recovery fixture</h1>
<label>Unsaved editor buffer <textarea aria-label="Unsaved editor buffer"></textarea></label>
<p role="status">Connecting</p><ul aria-label="Observed source files"></ul>
<button type="button">Close subscription</button>
<script type="module">
import {FactorySourceClient} from "/source-client.js";
const client=new FactorySourceClient(new URL(location.href));
const status=document.querySelector('[role="status"]');
const stop=client.watch("workspace-a",async event=>{
  if(event.kind!=="resync")return;
  const files=await client.request("workspace-a","list",{path:""});
  const list=document.querySelector("ul");
  list.replaceChildren(...files.map(file=>{
    const item=document.createElement("li");item.textContent=file.name;return item;
  }));
  status.textContent="Source connected";
},retrying=>{status.textContent=retrying?"Source reconnecting":"Source unavailable";});
document.querySelector("button").onclick=()=>{stop();status.textContent="Subscription closed";};
</script></html>`,
          { headers: { "content-type": "text/html" } },
        );
      if (path === "/editor/__factory/workspaces/workspace-a/source/stat") {
        observed.rootReads++;
        return Response.json({ kind: "directory" }, { status: rootStatus });
      }
      if (path === "/editor/__factory/workspaces/workspace-a/source/list")
        return Response.json([{ name: "app.ts", kind: "file", size: 12, mtime: 1, ctime: 1 }]);
      if (path === "/editor/__factory/workspaces/workspace-a/source/events") {
        observed.streams++;
        if (observed.streams === 1)
          return Response.json({ error: "Owned temporary watch failure" }, { status: 403 });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ kind: "resync", path: "" })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
        );
      }
      if (request.method !== "GET") observed.writes++;
      return new Response(null, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/editor/`,
    observed,
    async dispose() {
      await server.stop(true);
    },
  };
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "narrow", width: 390, height: 844, touch: false },
  { name: "touch", width: 768, height: 1024, touch: true },
]) {
  test.describe(viewport.name, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
    });
    test("a rejected browser stream recovers source and keeps the unsaved buffer", async ({
      page,
    }, testInfo) => {
      const owned = await sourceWatchFixture();
      try {
        await page.goto(owned.url);
        await page.getByLabel("Unsaved editor buffer").fill("Unsaved local edit");
        await expect(page.getByRole("status")).toHaveText("Source connected");
        await expect(page.getByRole("list", { name: "Observed source files" })).toHaveText(
          "app.ts",
        );
        await expect(page.getByLabel("Unsaved editor buffer")).toHaveValue("Unsaved local edit");
        expect(owned.observed).toEqual({ streams: 2, rootReads: 1, writes: 0 });
        await page.screenshot({
          path: testInfo.outputPath("source-reconnected.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Close subscription" }).click();
        await expect(page.getByRole("status")).toHaveText("Subscription closed");
      } finally {
        await owned.dispose();
      }
    });
  });
}

for (const status of [401, 403, 404]) {
  test(`root access ${status} ends recovery without replacing the browser stream`, async ({
    page,
  }) => {
    const owned = await sourceWatchFixture(status);
    try {
      await page.goto(owned.url);
      await expect(page.getByRole("status")).toHaveText("Source unavailable");
      await page.waitForTimeout(1_100);
      expect(owned.observed).toEqual({ streams: 1, rootReads: 1, writes: 0 });
    } finally {
      await owned.dispose();
    }
  });
}
