import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { CommandError } from "../../apps/factory/src/command-error";
import { setupInspectionView, setupReadiness } from "../../packages/project-domain/src/setup";
import { test } from "../fixtures/browser-test";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { factoryFixtureStart } from "../fixtures/start-plugins";

const evidence = ".factory/test-results/project-setup-settings";
const cache = resolve(".factory/test-results/vite", `setup-settings-${crypto.randomUUID()}`);
let frontend: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  frontend = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["project-inputs.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await frontend.listen();
  const url = frontend.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!url) throw new Error("Project setup settings fixture has no address");
  origin = url;
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await frontend?.close();
  await rm(cache, { recursive: true, force: true });
});

for (const device of [
  { name: "desktop", width: 1440, height: 1000, hasTouch: false },
  { name: "narrow", width: 390, height: 844, hasTouch: false },
  { name: "touch", width: 390, height: 844, hasTouch: true },
]) {
  test.describe(`project preparation on ${device.name}`, () => {
    test.use({
      viewport: { width: device.width, height: device.height },
      hasTouch: device.hasTouch,
    });
    test("resumes retained setup through Settings without inference or repository creation", async ({
      page,
    }) => {
      const projectID = "10000000-0000-4000-8000-000000000001";
      const inspectionID = crypto.randomUUID();
      const configurationCommand = crypto.randomUUID();
      const wikiCommand = crypto.randomUUID();
      let writes = 0;
      let statusReads = 0;
      const inspection = setupInspectionView.parse({
        id: inspectionID,
        projectID,
        sourceCommit: "a".repeat(40),
        state: "proposal",
        failure: null,
        output: {
          purpose: "Prepare the existing imported application.",
          services: [],
          uncertainty: [],
          files: [],
          questions: [{ id: "database", question: "Which isolated database should be used?" }],
        },
      });
      await mockFactoryFunctions(page, {
        setup: {
          inspection: async (_actor, project) => {
            expect(project).toBe(projectID);
            return inspection;
          },
          readiness: async (_actor, project) => {
            expect(project).toBe(projectID);
            statusReads++;
            return setupReadiness.parse([
              {
                task: "configuration",
                state: statusReads > 1 ? "running" : "pending",
                commandID: configurationCommand,
                operationID: null,
                failure: null,
              },
              {
                task: "wiki",
                state: "failed",
                commandID: wikiCommand,
                operationID: null,
                failure: "A previous Wiki update needs an explicit retry.",
              },
            ]);
          },
          inspect: async () => {
            writes++;
            throw new Error("Reading must not start inspection");
          },
          create: async () => {
            writes++;
            throw new Error("Settings must not create a repository");
          },
          begin: async () => {
            writes++;
            throw new Error("Settings must not replace the setup draft");
          },
        },
      });
      await page.goto(`${origin}/project-inputs.html`);
      if (device.width > 760)
        await expect(
          page
            .getByRole("navigation", { name: "Settings navigation" })
            .getByRole("button", { name: "Project setup", exact: true }),
        ).toBeVisible({ timeout: 2000 });
      await chooseSettingsPage(page, "Project setup", "Project · Invoice workspace");
      const panel = page.getByRole("region", { name: "Project configuration", exact: true });
      const answer = panel.getByRole("textbox", {
        name: "Which isolated database should be used?",
        exact: true,
      });
      await answer.fill("Separate local PostgreSQL only.");
      await page.clock.install();
      const preparation = page.getByRole("region", { name: "Project preparation", exact: true });
      const retry = preparation.getByRole("button", { name: "Retry", exact: true });
      await retry.focus();
      await page.clock.fastForward(2500);
      await expect(preparation.getByRole("img", { name: "running", exact: true })).toBeVisible();
      await expect(retry).toBeFocused();
      await chooseSettingsPage(page, "Environments", "Project · Invoice workspace");
      const readsBeforeLeaving = statusReads;
      await page.clock.fastForward(10_000);
      expect(statusReads).toBe(readsBeforeLeaving);
      await chooseSettingsPage(page, "Project setup", "Project · Invoice workspace");
      await expect(answer).toHaveValue("Separate local PostgreSQL only.");
      await page.reload();
      await chooseSettingsPage(page, "Project setup", "Project · Invoice workspace");
      await expect(answer).toHaveValue("Separate local PostgreSQL only.");
      await expect(
        page.getByRole("region", { name: "Project preparation", exact: true }),
      ).toContainText("Project configuration");
      expect(writes).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        device.width,
      );
      await page.screenshot({ path: `${evidence}/${device.name}.png` });
    });

    test("retrying a failed inspection preserves its retained context and clears the old failure while submitting", async ({
      page,
    }) => {
      const projectID = "10000000-0000-4000-8000-000000000001";
      const failedID = crypto.randomUUID();
      const failure = "Inspection timed out. Previous answers and source are unchanged.";
      let current = setupInspectionView.parse({
        id: failedID,
        projectID,
        sourceCommit: "a".repeat(40),
        state: "failed",
        output: null,
        failure,
      });
      let submitted:
        | { id: string; parentID?: string; answers?: Record<string, string> }
        | undefined;
      const received = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await mockFactoryFunctions(page, {
        setup: {
          inspection: async () => current,
          readiness: async () => [],
          inspect: async (_actor, project, id, continuation) => {
            expect(project).toBe(projectID);
            expect(submitted).toBeUndefined();
            submitted = { id, ...continuation };
            received.resolve();
            await release.promise;
            current = { ...current, id, state: "inspecting", failure: null };
            return current;
          },
        },
      });
      try {
        await page.goto(`${origin}/project-inputs.html`);
        await chooseSettingsPage(page, "Project setup", "Project · Invoice workspace");
        const panel = page.getByRole("region", { name: "Project configuration", exact: true });
        await expect(panel).toContainText(failure);
        expect(submitted).toBeUndefined();
        await page.screenshot({ path: `${evidence}/retry-before-${device.name}.png` });
        const retry = panel.getByRole("button", {
          name: /^(Inspect project setup|Retry setup inspection)$/,
        });
        if (device.hasTouch) await retry.tap();
        else await retry.press("Enter");
        await received.promise;
        expect(submitted).toMatchObject({ parentID: failedID, answers: {} });
        await expect(panel).not.toContainText(failure);
        release.resolve();
        await expect(
          panel.getByRole("button", { name: "Stop inspection", exact: true }),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          device.width,
        );
        await page.screenshot({ path: `${evidence}/retry-running-${device.name}.png` });
      } finally {
        release.resolve();
      }
    });
  });
}

test("Product Contributors cannot open source configuration or commission its inspection", async ({
  page,
}) => {
  let inspections = 0;
  await mockFactoryFunctions(page, {
    setup: {
      inspection: async () => {
        inspections++;
        return null;
      },
      inspect: async () => {
        inspections++;
        throw new Error("Contributor has no development authority");
      },
    },
  });
  await page.goto(`${origin}/project-inputs.html?role=viewer`);
  await expect(page.getByRole("navigation", { name: "Settings navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Project setup", exact: true })).toHaveCount(0);
  expect(inspections).toBe(0);
});

test("developers without Project management can read preparation but cannot change its configuration", async ({
  page,
}) => {
  let inspections = 0;
  await mockFactoryFunctions(page, {
    setup: {
      readiness: async () =>
        setupReadiness.parse([
          {
            task: "wiki",
            state: "failed",
            commandID: crypto.randomUUID(),
            operationID: null,
            failure: "A manager must retry this preparation.",
          },
        ]),
      inspection: async () => {
        inspections++;
        return null;
      },
      inspect: async () => {
        inspections++;
        throw new Error("Management authority is required");
      },
      retryTask: async () => {
        inspections++;
        throw new Error("Management authority is required");
      },
    },
  });
  await page.goto(`${origin}/project-inputs.html?role=developer`);
  await chooseSettingsPage(page, "Project setup", "Project · Invoice workspace");
  const preparation = page.getByRole("region", { name: "Project preparation", exact: true });
  await expect(preparation).toContainText("Project Wiki");
  await expect(preparation.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Project configuration", exact: true }),
  ).toHaveCount(0);
  expect(inspections).toBe(0);
});

test("configuration corrections retain the exact proposal, answers and unconfirmed command", async ({
  page,
}) => {
  const projectID = "10000000-0000-4000-8000-000000000001";
  const proposalID = crypto.randomUUID();
  let current = setupInspectionView.parse({
    id: proposalID,
    projectID,
    sourceCommit: "a".repeat(40),
    state: "proposal",
    failure: null,
    output: {
      purpose: "An imported application with a proposal awaiting review.",
      services: [],
      uncertainty: [],
      questions: [],
      files: [
        {
          path: ".factory/system.json",
          content:
            '{"version":1,"primaryApp":"web","apps":[{"id":"web","label":"Web","command":["pnpm","dev"],"port":4321,"healthPath":"/health"}]}',
        },
        {
          path: ".devcontainer/devcontainer.json",
          content:
            '{"image":"node:24-bookworm","workspaceFolder":"/workspace/project","remoteUser":"node"}',
        },
        {
          path: ".forgejo/workflows/factory-verification.yml",
          content:
            "on: pull_request\njobs:\n  verify:\n    runs-on: factory-verification\n    steps: [{run: 'pnpm test'}]\n",
        },
      ],
    },
  });
  const calls: unknown[] = [];
  let confirmations = 0;
  await mockFactoryFunctions(page, {
    setup: {
      inspection: async () => current,
      readiness: async () => [],
      confirm: async () => {
        confirmations++;
        throw new Error("Correction must not confirm source writes");
      },
      inspect: async (_actor, project, id, continuation) => {
        expect(project).toBe(projectID);
        calls.push({ id, ...continuation });
        if (calls.length === 1)
          throw new CommandError("unavailable", "Controlled unconfirmed response");
        current = { ...current, id, state: "inspecting", output: null };
        return current;
      },
    },
  });
  await page.goto(`${origin}/project-inputs.html`);
  await chooseSettingsPage(page, "Project setup", "Project · Invoice workspace");
  const panel = page.getByRole("region", { name: "Project configuration", exact: true });
  const disclosure = panel.getByText("Request configuration changes", { exact: true });
  await expect(disclosure).toBeVisible({ timeout: 2000 });
  await disclosure.click();
  const correction = panel.getByRole("textbox", {
    name: "Requested configuration changes",
    exact: true,
  });
  const feedback = "Use the pinned Node image and retain established behavioral checks.";
  await correction.fill(feedback);
  expect(calls).toHaveLength(0);
  await panel.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(correction).toBeDisabled();
  await expect(correction).toHaveValue(feedback);
  expect(calls[0]).toMatchObject({ parentID: proposalID, answers: { $feedback: feedback } });
  await page.screenshot({ path: `${evidence}/correction-unconfirmed-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidence}/correction-unconfirmed-narrow.png` });
  await page.reload();
  await chooseSettingsPage(page, "Project setup", "Project · Invoice workspace");
  await disclosure.click();
  await expect(correction).toBeDisabled();
  await expect(correction).toHaveValue(feedback);
  await panel.getByRole("button", { name: "Retry submitted setup", exact: true }).click();
  await expect(panel.getByText("Understanding your application…", { exact: true })).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(confirmations).toBe(0);
});
