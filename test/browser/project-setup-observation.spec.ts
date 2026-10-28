import { CommandError } from "../../apps/factory/src/command-error";
import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn } from "../support/factory-fixture";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { projectSetupView } from "../../packages/project-domain/src/setup";

test("an unconfirmed project creation becomes ready without a second button click", async ({
  page,
}) => {
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "No runtime in this setup UI fixture");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "No runtime in this setup UI fixture");
      },
    },
  });
  const setupID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  let created = false;
  let creates = 0;
  let statusChecks = 0;
  let submitted = false;
  let version = 1;
  let fields = { name: "", slug: "", kind: "starter", sourceURL: "" };
  const view = () =>
    projectSetupView.parse({
      id: setupID,
      version,
      ...fields,
      state: created ? "created" : submitted ? "checking" : "draft",
      projectID: created ? projectID : null,
      commandID: submitted ? setupID : null,
      failure: submitted && !created ? "Repository setup needs a status check." : null,
    });
  await mockFactoryFunctions(page, {
    setup: {
      draft: async () => view(),
      begin: async () => view(),
      save: async (_actor, input) => {
        fields = {
          name: input.name,
          slug: input.slug,
          kind: input.kind,
          sourceURL: input.sourceURL,
        };
        version++;
        return view();
      },
      create: async () => {
        creates++;
        submitted = true;
        return view();
      },
      check: async () => {
        statusChecks++;
        return view();
      },
      readiness: async () => [],
    },
  });
  await signIn(page);
  await openProjectMenu(page);
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
