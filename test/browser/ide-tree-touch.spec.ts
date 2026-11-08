import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { test } from "../fixtures/browser-test";

const cache = resolve(".factory/test-results/vite", `ide-tree-touch-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;
test.use({ hasTouch: true });
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [resolve(".")] } },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("Tree touch fixture address is missing");
  origin = address;
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});
test("the first touch tap opens its stable node before mouseenter disables row pointer events", async ({
  page,
}) => {
  await page.goto(`${origin}ide-tree-touch.html`);
  await page.getByRole("button", { name: "package.json", exact: true }).tap();
  await expect(page.getByLabel("Opened file")).toHaveText("package.json");
  await expect(page.getByLabel("Opened file")).toHaveAttribute("data-activations", "1");
  await expect(page.getByLabel("Opened file")).not.toHaveAttribute("data-mouse-clicks", "1");
});
