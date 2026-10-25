import { mockFactoryFunctions } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signIn } from "../support/factory-fixture";

test("the Board defers the editor, which retains editing and drafts after its lazy load", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // This proof owns a document draft, not IDE or source-access compute.
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Compute is outside this UI fixture.");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Compute is outside this UI fixture.");
      },
    },
  });
  const errors: string[] = [];
  const assets: Array<{ path: string; encoding: string; bytes: number; cache: string }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/assets/") || !path.endsWith(".js")) return;
    const headers = response.headers();
    assets.push({
      path,
      encoding: headers["content-encoding"] ?? "identity",
      bytes: Number(headers["content-length"] ?? 0),
      cache: headers["cache-control"] ?? "",
    });
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board", exact: true })).toBeVisible();
  expect(assets.some((asset) => asset.path.includes("/document-engine-"))).toBe(false);
  const initial = [...assets];
  const initialTiming = await page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => new URL(entry.name).pathname.startsWith("/assets/"))
      .map((entry) => ({
        path: new URL(entry.name).pathname,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
      })),
  );
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  const description = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await expect(description).toBeVisible();
  await description.fill("Keep this draft after lazy loading.");
  await description.press("End");
  await description.press("Enter");
  await description.pressSequentially("/hea");
  await page
    .getByRole("menu", { name: "Specification blocks", exact: true })
    .getByRole("menuitem", { name: "Heading", exact: true })
    .click();
  await description.pressSequentially("A heading after lazy load");
  await expect(description.locator("h2")).toHaveText("A heading after lazy load");
  expect(assets.some((asset) => asset.path.includes("/document-engine-"))).toBe(true);
  const directory = ".factory/test-results/document-loading";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(description).toContainText("Keep this draft after lazy loading.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${directory}/narrow.png`, fullPage: true });
  await page.getByRole("button", { name: "Desktop", exact: true }).click();
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  await expect(description).toContainText("A heading after lazy load");
  expect(
    assets.filter((asset) => asset.bytes > 1024).every((asset) => asset.encoding === "br"),
  ).toBe(true);
  expect(assets.every((asset) => asset.cache.includes("immutable"))).toBe(true);
  expect((await page.request.get("/server/entry.js")).status()).toBe(404);
  expect(errors).toEqual([]);
  await writeFile(
    `${directory}/assets.json`,
    JSON.stringify({ initial, initialTiming, afterEditing: assets }, null, 2),
  );
});
