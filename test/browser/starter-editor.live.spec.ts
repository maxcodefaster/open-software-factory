import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn } from "../support/factory-fixture";

test.skip(
  process.env["FACTORY_RUN_CLEAN_STARTER_EDITOR"] !== "1",
  "Uses the retained clean E2E Starter",
);
test("the clean Starter IDE reads canonical files without starting compute", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await openProjectMenu(page);
  await page
    .getByRole("region", { name: "Projects", exact: true })
    .getByRole("button")
    .filter({ hasText: "factory-e2e-starter" })
    .click();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const editor = page.frameLocator('iframe[title="Factory IDE"]');
  await expect(editor.getByText("package.json", { exact: true })).toBeVisible({ timeout: 45_000 });
  await editor.getByText("package.json", { exact: true }).dblclick();
  await expect(editor.locator(".monaco-editor:visible")).toHaveAttribute(
    "data-uri",
    /factory-workspace:\/\/[^/]+\/package\.json/,
  );
  await expect(editor.locator(".monaco-editor:visible")).toContainText("factory-starter");
  await expect(editor.locator(".factory-runtime-output:visible")).toContainText(
    "Workspace compute is stopped. Start it when you need a terminal or App.",
  );
  await mkdir(".factory/test-results/clean-e2e", { recursive: true });
  await page.screenshot({ path: ".factory/test-results/clean-e2e/05-independent-theia.png" });
});
