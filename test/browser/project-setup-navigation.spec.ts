import { expect, test } from "@playwright/test";
import { signIn } from "../support/factory-fixture";

test("opening a created Project leaves setup without reading its disposed conditional props", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  const draft = {
    id: "6daa4e4a-9f20-4327-b76a-f1e7f403ba34",
    version: 1,
    name: "Navigation regression",
    slug: "navigation-regression",
    kind: "starter",
    sourceURL: "",
    state: "created",
    projectID: "6daa4e4a-9f20-4327-b76a-f1e7f403ba35",
    commandID: "6daa4e4a-9f20-4327-b76a-f1e7f403ba36",
    failure: null,
  };
  await page.route("**/api/project-setup", (route) => route.fulfill({ json: draft }));
  await page.route(`**/api/projects/${draft.projectID}/setup`, (route) =>
    route.fulfill({ json: [] }),
  );
  await signIn(page);
  await page.getByRole("button", { name: "Open project menu", exact: true }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const setup = page.getByRole("region", { name: "Project setup", exact: true });
  await expect(setup.getByRole("heading", { name: draft.name })).toBeVisible();
  await setup.getByRole("button", { name: "Open project", exact: true }).click();
  expect(errors).toEqual([]);
  await expect(setup).toHaveCount(0, { timeout: 2000 });
});
