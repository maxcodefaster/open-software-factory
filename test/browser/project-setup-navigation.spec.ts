import { expect, type Page } from "@playwright/test";
import { CommandError } from "../../apps/factory/src/command-error";
import {
  projectSetupView,
  setupInspectionView,
  setupReadiness,
} from "../../packages/project-domain/src/setup";
import { test as base } from "../fixtures/browser-test";
import { factoryProcess } from "../fixtures/factory-process";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { openProjectMenu } from "../fixtures/project-menu";
import { mockFactoryFunctions } from "../fixtures/server-functions";

type SignIn = (page: Page) => Promise<void>;
const test = base.extend<
  { signIn: SignIn },
  {
    postgres: Awaited<ReturnType<typeof ownedPostgresServer>>;
    factory: Awaited<ReturnType<typeof factoryProcess>>;
  }
>({
  postgres: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
    async ({}, use) => {
      const postgres = await ownedPostgresServer();
      try {
        await use(postgres);
      } finally {
        await postgres.dispose();
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],
  factory: [
    async ({ postgres }, use) => {
      const previous = process.env["FACTORY_TEST_POSTGRES"];
      let factory: Awaited<ReturnType<typeof factoryProcess>>;
      try {
        process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
        factory = await factoryProcess();
      } finally {
        if (previous === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
        else process.env["FACTORY_TEST_POSTGRES"] = previous;
      }
      try {
        await factory.startPlanningCache();
        await factory.start();
        await use(factory);
      } finally {
        await factory.dispose();
      }
    },
    // The setup commands are mocked; each test owns a fresh browser context.
    // Share only this suite's authenticated host, never a retained installation.
    // Its cache and application readiness already allow 120s and 30s respectively.
    { scope: "worker", timeout: 180_000 },
  ],
  signIn: async ({ factory }, use) => {
    await use(async (page) => {
      await page.goto(factory.base);
      await page.getByLabel("Email", { exact: true }).fill(`owned-${factory.id}@factory.local`);
      await page
        .getByLabel("Password", { exact: true })
        .fill("owned-process-password-not-a-secret");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    });
  },
});

test.setTimeout(30_000);

for (const device of [
  { name: "desktop", width: 1440, height: 1000, hasTouch: false },
  { name: "narrow", width: 390, height: 844, hasTouch: false },
  { name: "touch", width: 390, height: 844, hasTouch: true },
]) {
  test.describe(`retained import recovery on ${device.name}`, () => {
    test.use({
      viewport: { width: device.width, height: device.height },
      hasTouch: device.hasTouch,
    });
    test("starts another draft explicitly without replaying the previous import", async ({
      page,
      signIn,
    }) => {
      let draft = projectSetupView.parse({
        id: crypto.randomUUID(),
        version: 1,
        name: "Private app",
        slug: "first-import",
        kind: "import",
        sourceURL: "https://github.com/team/private.git",
        state: "checking",
        projectID: null,
        commandID: crypto.randomUUID(),
        failure:
          "Repository setup is unconfirmed. Factory is checking without repeating creation or import.",
      });
      const previousID = draft.id;
      let starts = 0,
        imports = 0;
      await mockFactoryFunctions(page, {
        setup: {
          draft: async () => draft,
          begin: async () => draft,
          startAnother: async (_actor, id) => {
            expect(id).toBe(previousID);
            starts++;
            draft = {
              ...draft,
              id: crypto.randomUUID(),
              name: "",
              slug: "",
              sourceURL: "",
              kind: "starter",
              state: "draft",
              commandID: null,
              failure: null,
            };
            return draft;
          },
          create: async () => {
            imports++;
            throw new Error("Opening a draft must not import");
          },
        },
      });
      await signIn(page);
      await openProjectMenu(page);
      await page.getByRole("button", { name: "Continue setup", exact: true }).click();
      const setup = page.getByRole("region", { name: "Project setup", exact: true });
      await expect(
        setup.getByText(
          "Your previous repository and setup are retained. Use a different repository name for the new setup.",
        ),
      ).toBeVisible();
      const emptyBoard = page.getByRole("region", { name: "Empty project board", exact: true });
      await expect(emptyBoard.locator(".lane")).toHaveCount(4);
      for (const lane of await emptyBoard.locator(".lane").all()) {
        await expect(lane).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(lane).toHaveCSS("border-top-width", "0px");
        await expect(lane).toHaveCSS("border-radius", "0px");
      }
      await page.screenshot({ path: `.factory/test-results/setup-new-attempt-${device.name}.png` });
      await setup.getByRole("button", { name: "Start another setup", exact: true }).click();
      await expect(setup.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue(
        "",
      );
      await expect(setup.getByRole("button", { name: "Starter", exact: false })).toBeVisible();
      expect(starts).toBe(1);
      expect(imports).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        device.width,
      );
    });
  });
}

async function openImportedSetup(page: Page, signIn: SignIn) {
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
  await mockFactoryFunctions(page, {
    setup: {
      draft: async () => projectSetupView.parse(draft),
      begin: async () => projectSetupView.parse(draft),
      readiness: async () => [],
    },
  });
  return {
    projectID,
    async open() {
      await signIn(page);
      await openProjectMenu(page);
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await expect(page.getByRole("heading", { name: draft.name, exact: true })).toBeVisible();
      return page.getByRole("region", { name: "Project configuration", exact: true });
    },
  };
}

test("successful preparation hides technical fallback notes but retains actionable failures", async ({
  page,
  signIn,
}) => {
  const fixture = await openImportedSetup(page, signIn);
  await mockFactoryFunctions(page, {
    setup: {
      readiness: async () =>
        setupReadiness.parse([
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
        ]),
      inspection: async () => null,
    },
  });
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
  signIn,
}) => {
  const fixture = await openImportedSetup(page, signIn);
  let reads = 0,
    writes = 0;
  await mockFactoryFunctions(page, {
    setup: {
      inspection: async () => {
        if (++reads === 1) throw new CommandError("unavailable", "Controlled read failure");
        return null;
      },
      inspect: async () => {
        writes++;
        throw new Error("Read-only retry must never start inspection");
      },
    },
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
  signIn,
}) => {
  const fixture = await openImportedSetup(page, signIn);
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
  await mockFactoryFunctions(page, {
    setup: {
      inspection: async () =>
        setupInspectionView.parse(
          submissions.length > 1
            ? { ...inspection, id: childID, state: "inspecting", output: null }
            : inspection,
        ),
      inspect: async (_actor, _project, id, continuation) => {
        submissions.push({ id, ...continuation });
        if (submissions.length === 1)
          throw new CommandError("unavailable", "Response could not be confirmed");
        return setupInspectionView.parse({
          ...inspection,
          id: childID,
          state: "inspecting",
          output: null,
        });
      },
    },
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
  signIn,
}) => {
  const fixture = await openImportedSetup(page, signIn);
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
  await mockFactoryFunctions(page, {
    setup: {
      inspection: async () => setupInspectionView.parse(inspection),
      inspect: async (_actor, _project, id, continuation) => {
        submissions.push({ id, answers: { port: continuation?.answers?.["port"] ?? "" } });
        if (submissions.length === 1)
          throw new CommandError("conflict", "Review the current setup answers");
        return setupInspectionView.parse({ ...inspection, state: "superseded" });
      },
    },
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
  signIn,
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
  await mockFactoryFunctions(page, {
    setup: {
      draft: async () => projectSetupView.parse(draft),
      begin: async () => projectSetupView.parse(draft),
      readiness: async () => [],
    },
  });
  await signIn(page);
  await openProjectMenu(page);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const setup = page.getByRole("region", { name: "Project setup", exact: true });
  await expect(setup.getByRole("heading", { name: draft.name })).toBeVisible();
  await setup.getByRole("button", { name: "Open project", exact: true }).click();
  expect(errors).toEqual([]);
  await expect(setup).toHaveCount(0, { timeout: 2000 });
});
