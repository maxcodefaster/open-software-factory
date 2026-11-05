import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { test } from "../fixtures/browser-test";

const cache = resolve(".factory/test-results/vite", `ide-accessibility-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    optimizeDeps: { entries: ["ide-accessibility.html"] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("IDE accessibility fixture address is missing");
  origin = address.replace(/\/$/, "");
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

test("Theia tabs, landmarks and status entries get the roles their labels need", async ({
  page,
}) => {
  await page.goto(`${origin}/ide-accessibility.html`);
  const explorer = page.locator("#tab-explorer");
  await expect(explorer).toHaveAttribute("role", "tab");
  await expect(explorer).toHaveAttribute("aria-selected", "true");
  await expect(explorer).toHaveAttribute("aria-label", "Explorer");
  await expect(page.locator("#tab-search")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#theia-main-content-panel")).toHaveAttribute("role", "main");
  await expect(page.locator("#theia-bottom-content-panel")).toHaveAttribute("role", "region");
  await expect(page.locator("#theia-statusBar")).toHaveAttribute("aria-label", "Status bar");
  await expect(page.locator("#entry-command")).toHaveAttribute("role", "button");
  await expect(page.locator("#entry-command")).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#entry-static")).toHaveAttribute("role", "group");
  await expect(page.locator("#entry-static")).not.toHaveAttribute("tabindex", /.*/);

  // Theia moves the current marker by class. The selection follows without a rescan.
  await page.evaluate(() => {
    document.querySelector("#tab-explorer")?.classList.remove("lm-mod-current");
    document.querySelector("#tab-search")?.classList.add("lm-mod-current");
  });
  await expect(explorer).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#tab-search")).toHaveAttribute("aria-selected", "true");

  // Later additions are hardened too: an opened editor tab and an entry that gains a command.
  await page.evaluate(() => {
    const tab = document.createElement("li");
    tab.id = "tab-file";
    tab.className = "lm-TabBar-tab lm-mod-current";
    document.querySelector("#editors")?.append(tab);
    document.querySelector("#entry-static")?.classList.add("hasCommand");
  });
  await expect(page.locator("#tab-file")).toHaveAttribute("role", "tab");
  await expect(page.locator("#tab-file")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tab-file")).not.toHaveAttribute("aria-label", /.*/);
  await expect(page.locator("#entry-static")).toHaveAttribute("role", "button");
});

test("status entries with a command work from the keyboard and popups get landmarks", async ({
  page,
}) => {
  await page.goto(`${origin}/ide-accessibility.html`);
  await page.evaluate(() => {
    let clicks = 0;
    document.querySelector("#entry-command")?.addEventListener("click", () => {
      document.body.dataset["clicks"] = String(++clicks);
    });
  });
  await page.locator("#entry-command").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(page.locator("body")).toHaveAttribute("data-clicks", "2");

  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="lm-Menu"><ul role="menu"><li tabindex="0" role="presentation" class="lm-Menu-item" data-type="separator"></li></ul></div>
       <div class="theia-notifications-container"></div>
       <ul><li class="single-pref" tabindex="0"><div class="pref-name">Editor: Font Size</div><input type="number"></li></ul>
       <div id="settings"><ul class="settings-section"><li>Title</li></ul><li class="single-pref"><div class="pref-name">Editor: Tab Size</div><input type="number"></li></div>
       <div role="listbox"><div id="row" role="option" aria-level="1"></div></div>
       <textarea id="search" title="Search"></textarea>
       <input class="iPadShowKeyboard" type="button" id="keyboard">`,
    );
  });
  await expect(page.locator(".lm-Menu")).toHaveAttribute("aria-label", "Menu");
  const separator = page.locator(".lm-Menu-item");
  await expect(separator).toHaveAttribute("role", "separator");
  await expect(separator).not.toHaveAttribute("tabindex", /.*/);
  await expect(page.locator(".theia-notifications-container")).toHaveAttribute("role", "region");
  await expect(page.locator("input").first()).toHaveAttribute("aria-label", "Editor: Font Size");
  await expect(page.locator("#settings")).toHaveAttribute("role", "list");
  await expect(page.locator(".settings-section")).toHaveAttribute("role", "presentation");
  await expect(page.locator("#search")).toHaveAttribute("aria-label", "Search");
  await expect(page.locator("#row")).not.toHaveAttribute("aria-level", /.*/);
  await expect(page.locator("#keyboard")).toHaveAttribute("aria-label", "Show on-screen keyboard");
  // Monaco re-sets the level when it recycles a row.
  await page.evaluate(() => document.querySelector("#row")?.setAttribute("aria-level", "2"));
  await expect(page.locator("#row")).not.toHaveAttribute("aria-level", /.*/);
});
