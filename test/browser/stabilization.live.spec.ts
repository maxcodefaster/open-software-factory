import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { sourceWorkspaceViewSchema } from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn } from "../support/factory-fixture";

const projectID = process.env["FACTORY_STABILIZATION_PROJECT_ID"];
test.use({ trace: "off" });

async function openPersonalIDE(page: Page) {
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const menu = page.getByRole("menu", { name: "IDE instances", exact: true });
  if (await menu.isVisible()) await menu.getByRole("menuitem", { name: /My workspace/ }).click();
}

test("current Starter IDE reopens with usable source without starting compute", async ({
  page,
}) => {
  test.skip(!projectID, "Requires an explicitly selected existing Starter Project");
  if (!projectID) return;
  test.setTimeout(60_000);
  const diagnostics: Array<{ event: string; path?: string; status?: number; message?: string }> =
    [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/editor/") || path === "/api/developer-ide/access")
      diagnostics.push({ event: "response", path, status: response.status() });
  });
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/editor/") || path === "/api/developer-ide/access")
      diagnostics.push({
        event: "requestfailed",
        path,
        message: request.failure()?.errorText ?? "Request failed",
      });
  });
  page.on("console", (entry) => {
    if (entry.type() === "error" && /reconnecting channel|already open/.test(entry.text()))
      diagnostics.push({
        event: "console",
        message: entry.text().split("\n")[0] ?? "Editor connection error",
      });
  });
  const database = createDatabase(1);
  try {
    const [project] = await database.client<Array<{ slug: string }>>`
      SELECT slug FROM factory.project WHERE id=${projectID}
    `;
    if (!project) throw new Error("Selected stabilization Project does not exist");
    const initial = await database.client<Array<{ id: string }>>`
      SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}
    `;
    await signIn(page);
    const sourceResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/projects/${projectID}/source-workspace/ensure`),
    );
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: project.slug }).click();
    await mkdir(".factory/screenshots/stabilization", { recursive: true });
    for (const phase of ["open", "reopen"] as const) {
      await openPersonalIDE(page);
      const source = sourceWorkspaceViewSchema.parse(await (await sourceResponse).json());
      const ide = page.frameLocator('iframe[title="Factory IDE"]');
      await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 15_000 });
      const file = ide.getByText("server.mjs", { exact: true }).first();
      if (!(await file.isVisible())) await ide.getByText("src", { exact: true }).first().click();
      await file.click();
      const editor = ide.locator(".monaco-editor:visible").first();
      await expect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${source.workspaceID}/src/server.mjs`,
      );
      await expect(page.locator('iframe[title="Factory IDE"]')).toHaveAttribute(
        "data-workspace-id",
        source.workspaceID,
      );
      await expect(editor.locator(".view-lines")).toContainText("createServer");
      await expect(page.getByText("Opening your editor…", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: `.factory/screenshots/stabilization/ide-${phase}.png` });
      if (phase === "reopen") {
        const opened = page.waitForEvent("popup");
        await page
          .getByRole("link", { name: "Open IDE · My workspace in new tab", exact: true })
          .click();
        const standalone = await opened;
        try {
          const file = standalone.getByText("server.mjs", { exact: true }).first();
          await expect(standalone.locator("#theia-app-shell")).toBeVisible({ timeout: 15_000 });
          if (!(await file.isVisible()))
            await standalone.getByText("src", { exact: true }).first().click();
          await file.click();
          const editor = standalone.locator(".monaco-editor:visible").first();
          await expect(editor).toHaveAttribute(
            "data-uri",
            `factory-workspace://${source.workspaceID}/src/server.mjs`,
          );
          await expect(editor.locator(".view-lines")).toContainText("createServer");
          await standalone.screenshot({
            path: ".factory/screenshots/stabilization/ide-new-tab.png",
          });
        } finally {
          await standalone.close();
        }
      }
      await page.getByRole("button", { name: "Close IDE · My workspace", exact: true }).click();
    }
    const final = await database.client<Array<{ id: string }>>`
      SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}
    `;
    expect(final.map((row) => row.id).sort()).toEqual(initial.map((row) => row.id).sort());
  } catch (cause) {
    await mkdir(".factory/test-results/stabilization", { recursive: true });
    await writeFile(
      ".factory/test-results/stabilization/ide-failed.json",
      JSON.stringify(diagnostics),
    );
    await page.screenshot({ path: ".factory/screenshots/stabilization/ide-failed.png" });
    throw cause;
  } finally {
    await database.client.end({ timeout: 5 });
  }
});

test("silent IDE document has a bounded retry instead of an endless opening state", async ({
  page,
}) => {
  test.skip(!projectID, "Requires an explicitly selected existing Starter Project");
  if (!projectID) return;
  test.setTimeout(45_000);
  const database = createDatabase(1);
  let documents = 0;
  let computeStarts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(personal-workspace|ticket-workspace)\/ensure$/.test(request.url())
    )
      computeStarts++;
  });
  try {
    const [project] = await database.client<Array<{ slug: string }>>`
      SELECT slug FROM factory.project WHERE id=${projectID}
    `;
    if (!project) throw new Error("Selected stabilization Project does not exist");
    await page.route("**/api/developer-ide/access?embed=1&epoch=*", (route) => {
      documents++;
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    await signIn(page);
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: project.slug }).click();
    await openPersonalIDE(page);
    await expect.poll(() => documents).toBe(1);
    const retry = page.getByRole("button", { name: "Retry editor connection", exact: true });
    await expect(retry).toBeVisible({ timeout: 31_000 });
    await expect(page.getByText("Opening your editor…", { exact: true })).toHaveCount(0);
    await retry.click();
    await expect.poll(() => documents).toBe(2);
    expect(computeStarts).toBe(0);
  } finally {
    await database.client.end({ timeout: 5 });
  }
});

test("current Starter Main-Preview retains the promoted instance across Ticket and IDE navigation", async ({
  page,
}) => {
  test.skip(!projectID, "Requires an explicitly selected existing Starter Project");
  if (!projectID) return;
  test.setTimeout(60_000);
  const database = createDatabase(1);
  let computeStarts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(personal-workspace|ticket-workspace|staging)\/ensure$/.test(request.url())
    )
      computeStarts++;
  });
  try {
    const [project] = await database.client<Array<{ slug: string; attemptID: string }>>`
      SELECT project.slug,preview.runtime_attempt_id AS "attemptID" FROM factory.project project
      JOIN factory.staging_preview preview ON preview.project_id=project.id
      JOIN factory.runtime_attempt attempt ON attempt.id=preview.runtime_attempt_id AND attempt.state='ready'
      WHERE project.id=${projectID}
    `;
    if (!project) throw new Error("Selected Starter does not have a ready promoted Main-Preview");
    await signIn(page);
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: project.slug }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const frame = page.locator('iframe[title="Factory Preview"]');
    const preview = page.frameLocator('iframe[title="Factory Preview"]');
    await expect(frame).toHaveAttribute("data-runtime-attempt-id", project.attemptID);
    await preview.getByRole("button", { name: "Add one", exact: true }).click();
    await expect(preview.getByText("1", { exact: true })).toBeVisible();
    const initialDocument = await frame.getAttribute("src");
    if (!initialDocument) throw new Error("Promoted Main-Preview document is missing");
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await page.getByRole("button").filter({ hasText: "Explain the first-run workflow" }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(preview.getByText("1", { exact: true })).toBeVisible();
    await openPersonalIDE(page);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(frame).toHaveAttribute("src", initialDocument);
    await expect(frame).toHaveAttribute("data-runtime-attempt-id", project.attemptID);
    await expect(preview.getByText("1", { exact: true })).toBeVisible();
    await expect(frame).toBeVisible();
    await expect(page.locator(".workspace-window")).toHaveCSS("opacity", "1");
    await expect(page.getByRole("tab", { name: "Preview · Staging", exact: true })).toHaveCount(1);
    expect(computeStarts).toBe(0);
    await page.screenshot({ path: ".factory/screenshots/stabilization/main-preview-reused.png" });
  } finally {
    await database.client.end({ timeout: 5 });
  }
});
