import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signIn } from "../support/factory-fixture";

test("an unconfirmed project creation becomes ready without a second button click", async ({
  page,
}) => {
  for (const action of ["source-workspace", "developer-ide"])
    await page.route(`**/api/projects/*/${action}/ensure`, (route) =>
      route.fulfill({ status: 503, json: { error: "No runtime in this setup UI fixture" } }),
    );
  const setupID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  let created = false;
  let creates = 0;
  let statusChecks = 0;
  let submitted = false;
  let version = 1;
  let fields = { name: "", slug: "", kind: "starter", sourceURL: "" };
  const view = () => ({
    id: setupID,
    version,
    ...fields,
    state: created ? "created" : submitted ? "checking" : "draft",
    projectID: created ? projectID : null,
    commandID: submitted ? setupID : null,
    failure: submitted && !created ? "Repository setup needs a status check." : null,
  });
  await page.route("**/api/project-setup", async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      fields = {
        name: input.name,
        slug: input.slug,
        kind: input.kind,
        sourceURL: input.sourceURL,
      };
      version++;
    }
    await route.fulfill({ json: view() });
  });
  await page.route("**/api/project-setup/create", async (route) => {
    creates++;
    submitted = true;
    await route.fulfill({ json: view() });
  });
  await page.route("**/api/project-setup/check", async (route) => {
    statusChecks++;
    await route.fulfill({ json: view() });
  });
  await page.route(`**/api/projects/${projectID}/setup`, (route) => route.fulfill({ json: [] }));
  await signIn(page);
  await page.getByRole("button", { name: "Open project menu", exact: true }).click();
  await page.getByRole("button", { name: "Continue setup", exact: true }).click();
  const setup = page.getByRole("region", { name: "Project setup", exact: true });
  await setup.getByLabel("Project name", { exact: true }).fill("Observed project");
  await setup.getByLabel("Repository name", { exact: true }).fill("observed-project");
  await setup.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(setup.getByRole("button", { name: "Check setup", exact: true })).toBeVisible();
  created = true;
  await expect(setup.getByRole("button", { name: "Open project", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(creates).toBe(1);
  expect(statusChecks).toBe(0);
  await mkdir(".factory/test-results/project-setup-observation", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/project-setup-observation/ready-without-manual-check.png",
  });
});
