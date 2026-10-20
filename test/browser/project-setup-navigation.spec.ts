import { expect, test } from "@playwright/test";
import { signIn } from "../support/factory-fixture";
test.setTimeout(30_000);

async function openImportedSetup(page: Parameters<typeof signIn>[0]) {
  const projectID = crypto.randomUUID();
  const draft = {
    id: crypto.randomUUID(),
    version: 1,
    name: "Owned recovery import",
    slug: `recovery-${projectID.slice(0, 8)}`,
    kind: "import",
    sourceURL: "https://example.invalid/owned.git",
    state: "created",
    projectID,
    commandID: crypto.randomUUID(),
    failure: null,
  };
  await page.route("**/api/project-setup", (route) => route.fulfill({ json: draft }));
  await page.route(`**/api/projects/${projectID}/setup`, (route) => route.fulfill({ json: [] }));
  return {
    projectID,
    path: `**/api/projects/${projectID}/setup/inspection`,
    async open() {
      await signIn(page);
      await page.getByRole("button", { name: "Open project menu", exact: true }).click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await expect(page.getByRole("heading", { name: draft.name, exact: true })).toBeVisible();
      return page.getByRole("region", { name: "Project configuration", exact: true });
    },
  };
}

test("successful preparation hides technical fallback notes but retains actionable failures", async ({
  page,
}) => {
  const fixture = await openImportedSetup(page);
  await page.route(`**/api/projects/${fixture.projectID}/setup`, (route) =>
    route.fulfill({
      json: [
        {
          task: "development",
          state: "ready",
          commandID: crypto.randomUUID(),
          operationID: null,
          failure: "This configuration uses normal startup instead of a prebuilt image.",
        },
        {
          task: "main-preview",
          state: "failed",
          commandID: crypto.randomUUID(),
          operationID: null,
          failure: "The application did not become ready.",
        },
      ],
    }),
  );
  await page.route(fixture.path, (route) => route.fulfill({ json: null }));
  await fixture.open();
  const preparation = page.getByRole("region", { name: "Project preparation", exact: true });
  await expect(preparation.getByText("Development image", { exact: true })).toBeVisible();
  await expect(preparation.getByText(/normal startup/)).toHaveCount(0);
  await expect(preparation.getByText("The application did not become ready.")).toBeVisible();
  await expect(preparation.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);
  await page.screenshot({ path: ".factory/test-results/setup-actionable-status.png" });
});

test("an initial inspection read failure offers a read-only retry without starting inference", async ({
  page,
}) => {
  const fixture = await openImportedSetup(page);
  let reads = 0,
    writes = 0;
  await page.route(fixture.path, (route) => {
    if (route.request().method() !== "GET") {
      writes++;
      return route.abort();
    }
    return ++reads === 1
      ? route.fulfill({ status: 503, json: { error: "Controlled read failure" } })
      : route.fulfill({ json: null });
  });
  const panel = await fixture.open();
  await expect(panel.getByRole("alert")).toContainText("Project inspection is unavailable");
  await page.screenshot({ path: ".factory/test-results/setup-read-retry.png" });
  await panel.getByRole("button", { name: "Retry inspection status", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Inspect project setup", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(reads).toBe(2);
  expect(writes).toBe(0);
});

test("an unconfirmed setup submission keeps its answers immutable and retries the same command explicitly", async ({
  page,
}) => {
  const fixture = await openImportedSetup(page);
  const inspection = {
    id: crypto.randomUUID(),
    projectID: fixture.projectID,
    sourceCommit: "a".repeat(40),
    state: "proposal",
    failure: null,
    output: {
      purpose: "Configure the imported app",
      services: [],
      uncertainty: [],
      files: [],
      questions: [{ id: "port", question: "Which port should the app use?" }],
    },
  };
  const submissions: unknown[] = [];
  const childID = crypto.randomUUID();
  await page.route(fixture.path, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json:
          submissions.length > 1
            ? { ...inspection, id: childID, state: "inspecting", output: null }
            : inspection,
      });
    submissions.push(route.request().postDataJSON());
    return submissions.length === 1
      ? route.fulfill({ status: 503, json: { error: "Response could not be confirmed" } })
      : route.fulfill({ json: { ...inspection, id: childID, state: "inspecting", output: null } });
  });
  const panel = await fixture.open();
  const answer = panel.getByRole("textbox", {
    name: "Which port should the app use?",
    exact: true,
  });
  await answer.fill("3000");
  await panel.getByRole("button", { name: "Continue setup", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Response could not be confirmed");
  await expect(answer).toBeDisabled();
  await expect(answer).toHaveValue("3000");
  await expect(
    panel.getByText("Your submitted answers are retained.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: ".factory/test-results/setup-submission-recovery.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".factory/test-results/setup-submission-recovery-narrow.png" });
  await page.reload();
  await expect(answer).toBeDisabled();
  await expect(answer).toHaveValue("3000");
  await panel.getByRole("button", { name: "Retry submitted setup", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toEqual(submissions[0]);
  await expect(panel.getByText("Understanding your application…", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Retry submitted setup", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: ".factory/test-results/setup-recovery-confirmed.png" });
});

test("a definite setup rejection refreshes state and allows an explicitly corrected submission", async ({
  page,
}) => {
  const fixture = await openImportedSetup(page);
  const inspection = {
    id: crypto.randomUUID(),
    projectID: fixture.projectID,
    sourceCommit: "a".repeat(40),
    state: "proposal",
    failure: null,
    output: {
      purpose: "Configure the imported app",
      services: [],
      uncertainty: [],
      files: [],
      questions: [{ id: "port", question: "Which port should the app use?" }],
    },
  };
  const submissions: Array<{ id: string; answers: { port: string } }> = [];
  await page.route(fixture.path, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: inspection });
    submissions.push(route.request().postDataJSON());
    return submissions.length === 1
      ? route.fulfill({ status: 409, json: { error: "Review the current setup answers" } })
      : route.fulfill({ json: { ...inspection, state: "superseded" } });
  });
  const panel = await fixture.open();
  const answer = panel.getByRole("textbox", {
    name: "Which port should the app use?",
    exact: true,
  });
  await answer.fill("3000");
  await panel.getByRole("button", { name: "Continue setup", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Review the current setup answers");
  await expect(answer).toBeEnabled();
  await answer.fill("4000");
  await panel.getByRole("button", { name: "Continue setup", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0]?.answers.port).toBe("3000");
  expect(submissions[1]?.answers.port).toBe("4000");
  expect(submissions[1]?.id).not.toBe(submissions[0]?.id);
});

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
