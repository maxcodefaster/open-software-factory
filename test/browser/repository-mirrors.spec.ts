import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import type { RepositoryMirrorView } from "../../packages/project-domain/src/repository-mirror";
import { test } from "../fixtures/browser-test";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { factoryFixtureStart } from "../fixtures/start-plugins";

const evidence = ".factory/test-results/repository-mirror-ui";
const cache = resolve(".factory/test-results/vite", `mirrors-${crypto.randomUUID()}`);
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["repository-mirrors.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("Mirror fixture address missing");
  origin = address.replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

for (const width of [1440, 390, 320]) {
  test(`admin mirror setup, native status and removal remain usable at ${width}px`, async ({
    page,
  }) => {
    const projectID = "10000000-0000-4000-8000-000000000001";
    let view: RepositoryMirrorView = { projectID, mirrors: [], pending: null };
    let writes = 0;
    await mockFactoryFunctions(page, {
      access: {
        authentication: async () => ({
          fresh: true,
          companySignIn: false,
          email: "admin@fixture.test",
        }),
      },
      repositoryMirrors: {
        projects: async () => [{ id: projectID, name: "Invoice workspace" }],
        get: async () => view,
        create: async (_actor, project, input) => {
          expect(project).toBe(projectID);
          expect(input.token).toBe("fixture-only-secret");
          expect(input.confirmOverwrite).toBe(true);
          writes++;
          view = {
            ...view,
            mirrors: [
              {
                remoteName: "remote_mirror_owned",
                targetURL: input.targetURL,
                syncOnCommit: true,
                interval: "1h0m0s",
                branchFilter: "",
                lastAttempt: null,
                failed: false,
              },
            ],
          };
          return view;
        },
        sync: async () => {
          writes++;
          view = {
            ...view,
            mirrors: view.mirrors.map((mirror) => ({
              ...mirror,
              lastAttempt: "2026-10-27T09:00:00Z",
            })),
          };
          return view;
        },
        remove: async () => {
          writes++;
          view = { ...view, mirrors: [] };
          return view;
        },
      },
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${origin}/repository-mirrors.html`);
    await chooseSettingsPage(page, "Repository mirrors", "Factory administration");
    const region = page.getByRole("region", { name: "Repository mirrors", exact: true });
    await expect(region.getByText("No external mirror configured for this Project.")).toBeVisible();
    expect(writes).toBe(0);
    await region
      .getByLabel("Target Git URL", { exact: true })
      .fill("https://github.com/team/invoices.git");
    await region.getByLabel("Git username", { exact: true }).fill("git-user");
    await region.getByLabel("Access token", { exact: true }).fill("fixture-only-secret");
    await expect(region.getByLabel("Access token", { exact: true })).toHaveAccessibleDescription(
      /Git configuration, not in OpenBao\. Forgejo does not encrypt it/,
    );
    const add = region.getByRole("button", { name: "Add mirror", exact: true });
    await expect(add).toBeDisabled();
    await region.getByRole("checkbox").check();
    await region
      .getByLabel("Target Git URL", { exact: true })
      .fill("https://github.com/team/other.git");
    await expect(region.getByRole("checkbox")).not.toBeChecked();
    await region
      .getByLabel("Target Git URL", { exact: true })
      .fill("https://github.com/team/invoices.git");
    await region.getByRole("checkbox").check();
    await expect(add).toBeEnabled();
    await expect(add).toHaveCSS("opacity", "1");
    if (width !== 320) {
      await page.screenshot({
        path: `${evidence}/credentials-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await add.click();
    await expect(region.getByText("No successful synchronization confirmed yet.")).toBeVisible();
    await expect(region.getByRole("form", { name: "Add a mirror", exact: true })).toHaveCount(0);
    await expect(region.getByRole("button", { name: "Sync now", exact: true })).toBeFocused();
    const another = region.getByRole("button", { name: "Add mirror", exact: true });
    await another.click();
    await expect(region.getByLabel("Target Git URL", { exact: true })).toBeFocused();
    await expect(region.getByLabel("Target Git URL", { exact: true })).toHaveValue("");
    await expect(region.getByLabel("Git username", { exact: true })).toHaveValue("");
    await expect(region.getByLabel("Access token", { exact: true })).toHaveValue("");
    await expect(region.getByRole("checkbox")).not.toBeChecked();
    await region.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(another).toBeFocused();
    await region.getByRole("button", { name: "Sync now", exact: true }).click();
    await expect(region.getByText("Last observed attempt succeeded.")).toBeVisible();
    await region.evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        parent.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: `${evidence}/configured-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    view = {
      ...view,
      mirrors: view.mirrors.map((mirror) => ({
        ...mirror,
        lastAttempt: "2026-10-27T10:00:00Z",
        failed: true,
      })),
    };
    await region.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(region.getByText(/Last attempt failed/)).toBeVisible();
    await expect(
      region.getByText("Forgejo confirmed synchronization of this Project's mirror targets."),
    ).toHaveCount(0);
    if (width === 320) {
      await region.evaluate((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement)
          parent.scrollTop = 0;
        window.scrollTo(0, 0);
      });
      await page.screenshot({ path: `${evidence}/failed-320.png`, fullPage: true });
    }
    await region.getByRole("button", { name: "Remove mirror…", exact: true }).click();
    await expect(
      region.getByText(/The external repository and its code are not deleted/),
    ).toBeVisible();
    await region.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect(region.getByText("No external mirror configured for this Project.")).toBeVisible();
    expect(writes).toBe(3);
  });
}
test("Project contributors do not receive Factory mirror administration", async ({ page }) => {
  await mockFactoryFunctions(page, {
    access: {
      authentication: async () => ({
        fresh: true,
        companySignIn: false,
        email: "contributor@fixture.test",
      }),
      policy: async () => ({ companySignIn: false, sessionDays: 7 }),
    },
  });
  await page.goto(`${origin}/repository-mirrors.html?contributor`);
  await expect(
    page.getByRole("heading", { name: "Factory administration", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Repository mirrors", exact: true })).toHaveCount(
    0,
  );
});

test.describe("touch mirror settings", () => {
  test.use({ viewport: { width: 390, height: 1000 }, isMobile: true, hasTouch: true });
  test("cancelling an additional mirror clears credentials without a write", async ({ page }) => {
    const projectID = "10000000-0000-4000-8000-000000000001";
    let writes = 0;
    await mockFactoryFunctions(page, {
      access: {
        authentication: async () => ({
          fresh: true,
          companySignIn: false,
          email: "admin@fixture.test",
        }),
      },
      repositoryMirrors: {
        projects: async () => [{ id: projectID, name: "Invoice workspace" }],
        get: async () => ({
          projectID,
          pending: null,
          mirrors: [
            {
              remoteName: "remote_mirror_owned",
              targetURL: "https://github.com/team/invoices.git",
              syncOnCommit: true,
              interval: "1h0m0s",
              branchFilter: "",
              lastAttempt: null,
              failed: false,
            },
          ],
        }),
        create: async () => {
          writes++;
          throw new Error("No write expected");
        },
      },
    });
    await page.goto(`${origin}/repository-mirrors.html`);
    await chooseSettingsPage(page, "Repository mirrors", "Factory administration");
    const region = page.getByRole("region", { name: "Repository mirrors", exact: true });
    const another = region.getByRole("button", { name: "Add mirror", exact: true });
    await another.tap();
    await region
      .getByLabel("Target Git URL", { exact: true })
      .fill("https://gitlab.com/team/copy.git");
    await region.getByLabel("Git username", { exact: true }).fill("git-user");
    await region.getByLabel("Access token", { exact: true }).fill("discard-this-fixture-secret");
    await region.getByRole("checkbox").check();
    await region.getByRole("button", { name: "Cancel", exact: true }).tap();
    await another.tap();
    await expect(region.getByLabel("Access token", { exact: true })).toHaveValue("");
    await expect(region.getByRole("checkbox")).not.toBeChecked();
    expect(writes).toBe(0);
  });
});

test("failed attempts and uncertain operations stay distinct and acknowledgement never retries", async ({
  page,
}) => {
  const projectID = "10000000-0000-4000-8000-000000000001";
  const commandID = "20000000-0000-4000-8000-000000000001";
  let view: RepositoryMirrorView = {
    projectID,
    mirrors: [
      {
        remoteName: "remote_mirror_owned",
        targetURL: "https://github.com/team/invoices.git",
        syncOnCommit: true,
        interval: "1h0m0s",
        branchFilter: "",
        lastAttempt: "2026-10-27T09:00:00Z",
        failed: true,
      },
    ],
    pending: { commandID, action: "sync" },
  };
  let acknowledgements = 0;
  await mockFactoryFunctions(page, {
    access: {
      authentication: async () => ({
        fresh: true,
        companySignIn: false,
        email: "admin@fixture.test",
      }),
    },
    repositoryMirrors: {
      projects: async () => [{ id: projectID, name: "Invoice workspace" }],
      get: async () => view,
      acknowledge: async (_actor, project, inputCommandID) => {
        expect(project).toBe(projectID);
        expect(inputCommandID).toBe(commandID);
        acknowledgements++;
        view = { ...view, pending: null };
        return view;
      },
    },
  });
  await page.goto(`${origin}/repository-mirrors.html`);
  await chooseSettingsPage(page, "Repository mirrors", "Factory administration");
  const region = page.getByRole("region", { name: "Repository mirrors", exact: true });
  await expect(region.getByText(/Last attempt failed/)).toBeVisible();
  await expect(region.getByText(/A mirror operation is unconfirmed/)).toBeVisible();
  await expect(region.getByRole("button", { name: "Sync now", exact: true })).toBeDisabled();
  await region.getByRole("button", { name: "Refresh status", exact: true }).click();
  expect(acknowledgements).toBe(0);
  await region.getByRole("button", { name: "Keep observed configuration", exact: true }).click();
  await expect(region.getByText(/The operation was not repeated/)).toBeVisible();
  await expect(region.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled();
  expect(acknowledgements).toBe(1);
});
