import { test } from "bun:test";
import { expect as visible } from "@playwright/test";
import { attemptsResponseSchema } from "../../apps/factory/src/api-contracts";
import { releaseInstallation } from "../fixtures/release-installation";

const installation = process.env["FACTORY_RELEASE_INSTALLATION"];
test.skipIf(!installation)(
  "an open Staging tab follows the confirmed promotion without reopening",
  async () => {
    if (!installation) throw new Error("Explicit disposable installation required");
    const f = await releaseInstallation(installation);
    try {
      const cookie = await f.login("developer");
      const changeID = f.state.changeID;
      if (!changeID) throw new Error("Release Change required");
      const { attempts } = attemptsResponseSchema.parse(
        await f.command(cookie, `/api/runtime-attempts?projectId=${f.state.projectID}`),
      );
      const current = attempts.find((a) => a.currentStaging && a.state === "ready");
      const [previous] = await f.database.client<
        { id: string }[]
      >`SELECT previous_runtime_attempt_id AS id FROM factory.promotion_operation WHERE change_id = ${changeID}`;
      if (!current || !previous) throw new Error("Completed genuine promotion required");
      const old = { ...current, id: previous.id, state: "stopped", currentStaging: false };
      const page = await f.page("developer");
      let promoted = false;
      await page.route("**/api/runtime-attempts?*", (route) =>
        route.fulfill({
          json: {
            attempts: [old, ...attempts].map((a) =>
              a.id === old.id
                ? { ...a, state: promoted ? "stopped" : "ready", currentStaging: !promoted }
                : a.id === current.id
                  ? { ...a, state: promoted ? "ready" : "starting", currentStaging: promoted }
                  : a,
            ),
          },
        }),
      );
      await page.route("**/api/runtime-access?*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<h1>${promoted ? "Delivered revision" : "Previous revision"}</h1>`,
        }),
      );
      await f.selectProject(page);
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      const option = page.getByRole("menuitem", { name: /Staging/ });
      if (await option.isVisible()) await option.click();
      const frame = page.locator('iframe[title="Factory Preview"]');
      await visible(frame).toHaveAttribute("data-runtime-attempt-id", old.id);
      await visible(frame.contentFrame().locator("h1")).toHaveText("Previous revision");
      promoted = true;
      await visible(frame).toHaveAttribute("data-runtime-attempt-id", current.id, {
        timeout: 8_000,
      });
      await visible(frame.contentFrame().locator("h1")).toHaveText("Delivered revision");
    } finally {
      await f.close();
    }
  },
  30_000,
);
