import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect as visible } from "@playwright/test";
import { factoryProcess } from "../fixtures/factory-process";
import { openProjectMenu } from "../fixtures/project-menu";

test("setup side panel retains its draft through minimize, refresh and Factory Settings", async () => {
  const process = await factoryProcess(undefined, {
    FACTORY_PLANNING_MODEL_BASE_URL: "https://models.example/v1",
    FACTORY_PLANNING_MODEL_API_KEY: "owned-unused-model-key",
    FACTORY_PROJECT_AGENT_MODEL: "gpt-6-luna",
  });
  const database = process.connect();
  const browser = await chromium.launch({
    headless: true,
    ...(globalThis.process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: globalThis.process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : {}),
  });
  try {
    await process.start();
    const cookie = await process.signIn();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(
      cookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: process.base,
      })),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.base);
    await openProjectMenu(page);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await visible(page.getByRole("region", { name: "Empty project board" })).toBeVisible();
    const setup = page.getByRole("region", { name: "Project setup" });
    await setup.getByLabel("Project name", { exact: true }).fill("Quiet product");
    await visible(setup.getByText("Draft retained", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Minimize Agent panel" }).click();
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    await visible(setup.getByLabel("Project name", { exact: true })).toHaveValue("Quiet product");
    await page.reload();
    await visible(setup.getByLabel("Project name", { exact: true })).toHaveValue("Quiet product");
    await setup.getByLabel("Project name", { exact: true }).fill("Retained immediately");
    await page.reload();
    await visible(setup.getByLabel("Project name", { exact: true })).toHaveValue(
      "Retained immediately",
    );
    await setup.getByRole("button", { name: "Models and protected settings" }).click();
    await visible(page.getByRole("navigation", { name: "Settings navigation" })).toBeVisible();
    await visible(
      page
        .getByRole("navigation", { name: "Settings navigation" })
        .getByRole("button", { name: "Models", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await visible(page.getByLabel(/Use deployment connection/)).toBeVisible();
    await page.screenshot({
      path: ".factory/screenshots/project-setup/models-desktop.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Minimize workspace" }).click();
    await visible(setup.getByLabel("Project name", { exact: true })).toHaveValue(
      "Retained immediately",
    );
    await mkdir(".factory/screenshots/project-setup", { recursive: true });
    await page.screenshot({
      path: ".factory/screenshots/project-setup/retained-desktop.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 430, height: 900 });
    await visible(setup.getByLabel("Project name", { exact: true })).toBeVisible();
    await page.screenshot({
      path: ".factory/screenshots/project-setup/retained-narrow.png",
      animations: "disabled",
    });
    expect(errors).toEqual([]);
    expect((await database.client`SELECT id FROM factory.project`).length).toBe(0);
    const [draft] = await database.client`SELECT name FROM factory.project_setup_draft`;
    expect(draft?.["name"]).toBe("Retained immediately");
  } finally {
    await browser.close();
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 60_000);

test("setup questions retain answers across refresh and minimize; readiness resumes observation after retry", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const browser = await chromium.launch({ headless: true });
  try {
    await process.start();
    const cookie = await process.signIn();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(
      cookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: process.base,
      })),
    );
    const page = await context.newPage();
    await page.goto(process.base);
    await openProjectMenu(page);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const setup = page.getByRole("region", { name: "Project setup" });
    await visible(setup.getByLabel("Project name", { exact: true })).toBeVisible();
    const [draft] = await database.client<
      { id: string; userID: string }[]
    >`SELECT id,user_id AS "userID" FROM factory.project_setup_draft`;
    if (!draft) throw new Error("Owned setup draft missing");
    const projectID = crypto.randomUUID();
    const inspectionID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`owned-${projectID}`},'Imported application','http://127.0.0.1:9/owned-process-fixture/app','main','.devcontainer/devcontainer.json',${draft.userID})`;
    await database.client`UPDATE factory.project_setup_draft SET state='created',name='Imported application',kind='import',project_id=${projectID} WHERE id=${draft.id}`;
    await database.client`INSERT INTO factory.project_setup_inspection(id,project_id,source_commit,state,created_by,output)
      VALUES(${inspectionID},${projectID},${"a".repeat(40)},'proposal',${draft.userID},${JSON.stringify({ purpose: "A small internal application for support teams.", services: [{ name: "Web", description: "Existing application", port: 4300 }], uncertainty: [], questions: [{ id: "command", question: "Which existing command starts the application?" }], files: [] })}::jsonb)`;
    const task = {
      task: "wiki",
      state: "failed",
      commandID: crypto.randomUUID(),
      operationID: null,
      failure: "Wiki generation needs retry.",
    };
    let observations = 0;
    let retry = false;
    await page.route(`**/api/projects/${projectID}/setup`, async (route) => {
      observations++;
      await route.fulfill({
        json: [
          { ...task, state: retry ? "ready" : "failed", failure: retry ? null : task.failure },
        ],
      });
    });
    await page.route(`**/api/projects/${projectID}/setup/retry`, async (route) => {
      retry = true;
      await route.fulfill({ json: [{ ...task, state: "running", failure: null }] });
    });
    await page.reload();
    const question = setup.getByLabel("Which existing command starts the application?");
    await visible(question).toBeVisible();
    await question.fill("npm run dev");
    await page.reload();
    await visible(question).toHaveValue("npm run dev");
    await page.getByRole("button", { name: "Minimize Agent panel" }).click();
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    await visible(question).toHaveValue("npm run dev");
    const readiness = setup.getByRole("region", { name: "Project preparation" });
    const beforeRetry = observations;
    await readiness.getByRole("button", { name: "Retry", exact: true }).click();
    await visible(readiness.getByRole("img", { name: "ready" })).toBeVisible();
    expect(observations).toBeGreaterThan(beforeRetry);
    await page.screenshot({
      path: ".factory/screenshots/project-setup/inspection-desktop.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 430, height: 900 });
    await visible(question).toBeVisible();
    await page.screenshot({
      path: ".factory/screenshots/project-setup/inspection-narrow.png",
      animations: "disabled",
    });
    await setup.getByRole("button", { name: "Discard proposal" }).click();
    await visible(
      setup.getByRole("button", { name: "Inspect project setup", exact: true }),
    ).toBeVisible();
    expect(
      (
        await database.client`SELECT state FROM factory.project_setup_inspection WHERE id=${inspectionID}`
      )[0]?.["state"],
    ).toBe("superseded");
  } finally {
    await browser.close();
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 60_000);
