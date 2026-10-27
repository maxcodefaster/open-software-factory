import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chromium, expect as visible } from "@playwright/test";

test("real IDE input reaches automatic Resume before widgets stop event propagation", async () => {
  const build = await Bun.build({
    entrypoints: [
      resolve("deploy/theia-ide/factory-ide-extension/src/browser/factory-runtime-use.ts"),
    ],
    target: "browser",
  });
  if (!build.success || !build.outputs[0]) throw new Error("Runtime use fixture did not build");
  const script = await build.outputs[0].text();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/use.js"
        ? new Response(script, { headers: { "content-type": "text/javascript" } })
        : new Response(
            `<!doctype html><button id="tab">Terminal</button><script type="module">
import {observeFactoryRuntimeUse} from "/use.js";
window.calls=0;
const observer=observeFactoryRuntimeUse(document,()=>{window.calls++});
window.stopUse=()=>observer.dispose();
for(const name of ["pointerdown","wheel","keydown"])
  document.querySelector("button").addEventListener(name,event=>event.stopPropagation());
window.ready=true;
</script>`,
            { headers: { "content-type": "text/html" } },
          );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await visible.poll(() => page.evaluate(() => Reflect.get(window, "ready"))).toBe(true);
    const calls = () => page.evaluate(() => Reflect.get(window, "calls") as number);
    await page.locator("#tab").evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(await calls()).toBe(0);
    await page.locator("#tab").click();
    expect(await calls()).toBe(1);
    await page.keyboard.press("ArrowRight");
    expect(await calls()).toBe(2);
    await page.locator("#tab").hover();
    await page.mouse.wheel(0, 20);
    await visible.poll(calls).toBe(3);
    await page.evaluate(() =>
      Object.defineProperty(document, "hidden", { configurable: true, value: true }),
    );
    await page.locator("#tab").click();
    expect(await calls()).toBe(3);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      Reflect.get(window, "stopUse")();
    });
    await page.locator("#tab").click();
    await page.keyboard.press("ArrowRight");
    expect(await calls()).toBe(3);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
