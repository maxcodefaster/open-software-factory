import { resolve, sep } from "node:path";
import type { Page } from "@playwright/test";

/** Owned integration builds avoid HMR/dependency-cache races with other dev servers. */
export async function serveChatAssets(page: Page) {
  const directory = process.env["FACTORY_CHAT_FRONTEND_DIRECTORY"];
  if (!directory) return;
  const assetOrigin = process.env["FACTORY_CHAT_ASSET_ORIGIN"];
  if (!assetOrigin) throw new Error("Owned chat asset server missing");
  const root = resolve(directory);
  const origin = new URL(process.env["FACTORY_BROWSER_BASE_URL"] ?? "http://127.0.0.1:3000").origin;
  await page.context().grantPermissions(["local-network-access"], { origin });
  await page.route(
    (url) =>
      url.origin === origin &&
      (url.pathname === "/" ||
        url.pathname.startsWith("/assets/") ||
        url.pathname.startsWith("/art/")),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = resolve(root, path === "/" ? "index.html" : path.slice(1));
      if (!file.startsWith(root + sep)) throw new Error("Owned chat asset escaped its build");
      // A network-served document retains its loopback address space. Chromium
      // loses that identity for a fulfilled document on native SSE reconnect.
      return route.continue({ url: new URL(path, assetOrigin).href });
    },
  );
}
