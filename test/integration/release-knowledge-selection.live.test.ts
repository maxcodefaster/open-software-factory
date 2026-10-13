import { test } from "bun:test";
import { expect as visible } from "@playwright/test";
import { releaseInstallation } from "../fixtures/release-installation";

const installation = process.env["FACTORY_RELEASE_INSTALLATION"];
test.skipIf(!installation)(
  "Knowledge selects an available page after the current Project is reselected",
  async () => {
    if (!installation) throw new Error("Explicit disposable installation required");
    const f = await releaseInstallation(installation);
    try {
      const page = await f.page("developer");
      await f.selectProject(page);
      await page.getByRole("button", { name: "Knowledge", exact: true }).click();
      await page.getByRole("button", { name: "Container Topology", exact: true }).click();
      await visible(page.locator(".knowledge-article")).toBeVisible();
      await f.selectProject(page);
      await page.getByRole("button", { name: "Knowledge", exact: true }).click();
      await visible(page.locator(".knowledge-article")).toBeVisible();
      await visible(
        page.getByRole("button", { name: "Container Topology", exact: true }),
      ).toBeVisible();
    } finally {
      await f.close();
    }
  },
  20_000,
);
