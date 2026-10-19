import { expect } from "bun:test";
import { type Browser, expect as visible } from "@playwright/test";
import type { createDatabase } from "../../packages/db/src/client";
import {
  recordedEditorIdentity,
  removeEditorFixtureNamespaceInChild,
} from "./editor-source-resources";
import { eventually } from "./factory-process";

export async function starterSetupDesktop(input: {
  browser: Browser;
  base: string;
  cookie: string;
  projectID: string;
  database: ReturnType<typeof createDatabase>;
}) {
  const { browser, base, cookie, projectID } = input;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let ideCookie = "";
  let ideUserID = "";
  async function stopOwnedEditor() {
    if (!ideCookie || !ideUserID) return;
    const current = await fetch(`${base}/api/developer-ide`, { headers: { cookie: ideCookie } });
    const editor = await current.json();
    if (!editor) return;
    const identity = await recordedEditorIdentity(input.database, ideUserID);
    if (!identity) return;
    const stopped = await fetch(`${base}/api/developer-ide/stop`, {
      method: "POST",
      headers: { cookie: ideCookie, origin: base },
    });
    if (!stopped.ok) throw new Error("Owned Starter editor Stop failed");
    await eventually(
      async () =>
        (
          await (
            await fetch(`${base}/api/developer-ide`, {
              headers: { cookie: ideCookie },
            })
          ).json()
        ).state,
      (state) => state === "stopped",
      "Owned Starter editor did not Stop",
      60_000,
    );
    await removeEditorFixtureNamespaceInChild(identity.namespace, { ownerID: ideUserID });
  }
  try {
    await context.addCookies(
      cookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: base,
      })),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByRole("button", { name: "Open project menu", exact: true }).click();
    await page
      .locator("#project-popover .project-choice")
      .filter({ hasText: "Turnkey Starter" })
      .click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Settings navigation" });
    const projectGroup = navigation.locator("section").filter({ hasText: "Turnkey Starter" });
    await visible(projectGroup).toBeVisible();
    await projectGroup.getByRole("button", { name: "Environments", exact: true }).click();
    await visible(page.getByRole("heading", { name: "Environments", exact: true })).toBeVisible();
    await visible(page.getByText("Variables", { exact: true })).toBeVisible();
    await page.screenshot({
      path: ".factory/screenshots/project-setup/settings-project-desktop.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 430, height: 900 });
    await visible(
      projectGroup.getByRole("button", { name: "Environments", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".factory/screenshots/project-setup/settings-project-narrow.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    // A disposed namespace cannot be reused under an IDE's retained ownership UID.
    const email = `starter-developer-${crypto.randomUUID()}@factory.local`;
    const password = "owned-starter-desktop-not-a-production-secret";
    async function command(path: string, body: unknown) {
      const response = await fetch(base + path, {
        method: "POST",
        headers: { cookie, origin: base, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Starter desktop ${path} failed: ${response.status}`);
      return response;
    }
    const accounts = await (await fetch(`${base}/api/admin/users`, { headers: { cookie } })).json();
    const user =
      accounts.users.find((value: { email: string }) => value.email === email) ??
      (await (
        await command("/api/admin/users", { name: "Starter developer", email, password })
      ).json());
    await command(`/api/projects/${projectID}/members`, { email, role: "developer" });
    const signIn = await command("/api/auth/sign-in/email", { email, password });
    ideUserID = user.id;
    ideCookie = signIn.headers
      .getSetCookie()
      .map((part) => part.split(";")[0])
      .join("; ");
    await context.clearCookies();
    await context.addCookies(
      ideCookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: base,
      })),
    );
    await page.reload();
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    const iframe = page.locator('iframe[title="Factory IDE"]');
    const frame = page.frameLocator('iframe[title="Factory IDE"]');
    await visible(frame.locator("#files").getByText("src", { exact: true })).toBeVisible({
      timeout: 150_000,
    });
    const workspaceID = await iframe.getAttribute("data-workspace-id");
    expect(workspaceID).toBeTruthy();
    await frame.locator("#files").getByText("src", { exact: true }).click();
    await frame.locator("#files").getByText("web.tsx", { exact: true }).dblclick();
    const editor = frame.locator(".monaco-editor:visible");
    await visible(editor).toHaveAttribute(
      "data-uri",
      `factory-workspace://${workspaceID}/src/web.tsx`,
    );
    // Monaco renders only viewport lines; the home heading is below the initial viewport.
    await visible(editor.locator(".view-lines")).toContainText('from "better-auth/client"');
    await page.screenshot({
      path: ".factory/screenshots/project-setup/starter-independent-ide.png",
      animations: "disabled",
    });
    expect(errors).toEqual([]);
    return { projectID, workspaceID };
  } finally {
    await context.close();
    await stopOwnedEditor();
  }
}
