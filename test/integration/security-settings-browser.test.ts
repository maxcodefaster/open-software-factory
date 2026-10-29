import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect as visible } from "@playwright/test";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { factoryProcess } from "../fixtures/factory-process";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  authenticatedBootstrap,
  browserFunction,
  callFactoryFunction,
} from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";

test("security Settings is a keyboard-accessible tab, reauthenticates in place, and fits narrow screens", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const browser = await chromium.launch({ headless: true });
  try {
    await owned.startPlanningCache();
    await owned.start();
    const cookie = await owned.signIn();
    const { session } = await authenticatedBootstrap(owned.base, { cookie });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(
      cookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: owned.base,
      })),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(owned.base);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Settings navigation" });
    await navigation.getByRole("button", { name: "Login & security" }).focus();
    await page.keyboard.press("Enter");
    const settings = page.getByRole("region", { name: "Login & security" });
    await visible(settings.getByText(/sessions renew with activity for 7 days/)).toBeVisible();
    await visible(settings.getByRole("button", { name: "Sign out here" })).toBeVisible();
    await database.client`UPDATE auth.session SET authenticated_at=now()-interval '6 minutes'`;
    // Focus refresh catches a session that expired while this tab remained open.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await visible(page.getByRole("region", { name: "Confirm your identity" })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Confirm identity", exact: true }).click();
    await visible(page.getByRole("region", { name: "Confirm your identity" })).toHaveCount(0);
    await visible(navigation).toBeVisible();
    await mkdir(".factory/test-results/enterprise-access", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/enterprise-access/security-desktop.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 430, height: 900 });
    await visible(settings.getByRole("button", { name: "Sign out here" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: ".factory/test-results/enterprise-access/security-narrow.png",
      animations: "disabled",
    });
    await chooseSettingsPage(page, "Company sign-in");
    await visible(page.getByLabel("Browser session duration")).toHaveValue("7");
    await page.screenshot({
      path: ".factory/test-results/enterprise-access/company-narrow.png",
      animations: "disabled",
    });
    await page.evaluate(
      ({ userID }) =>
        sessionStorage.setItem(
          "factory:security-return",
          JSON.stringify({ userID, scope: "system", category: "security" }),
        ),
      { userID: session.user.id },
    );
    await page.reload();
    await visible(page.getByRole("region", { name: "Company sign-in", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("factory:security-return"))).toBeNull();
    const email = `no-project-${owned.id}@factory.invalid`;
    const password = "owned-personal-password-not-a-secret";
    const account = await browserFunction(page, "createAccount", [
      { name: "New company member", email, password },
    ]);
    expect(account.ok).toBe(true);
    const login = await fetch(`${owned.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: owned.base, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const newContext = await browser.newContext({ viewport: { width: 430, height: 900 } });
    await newContext.addCookies(
      login.headers.getSetCookie().map((value) => ({
        name: value.slice(0, value.indexOf("=")),
        value: value.slice(value.indexOf("=") + 1, value.indexOf(";")),
        url: owned.base,
      })),
    );
    const personal = await newContext.newPage();
    await personal.goto(owned.base);
    await personal.getByRole("button", { name: "Settings", exact: true }).click();
    await personal.getByRole("button", { name: "Open settings", exact: true }).click();
    await visible(
      personal.getByRole("region", { name: "Login & security", exact: true }),
    ).toBeVisible();
    await visible(
      personal.getByRole("button", { name: "Company sign-in", exact: true }),
    ).toHaveCount(0);
    await personal.screenshot({
      path: ".factory/test-results/enterprise-access/no-project-security-narrow.png",
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await database.client.end({ timeout: 2 });
    await owned.dispose();
  }
}, 60_000);

test("a Product Contributor manages members without receiving code authority", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const browser = await chromium.launch({ headless: true });
  try {
    await owned.startPlanningCache();
    await owned.start();
    let cookie = await owned.signIn();
    const command = (path: string, body: unknown) =>
      fetch(`${owned.base}${path}`, {
        method: "POST",
        headers: { cookie, origin: owned.base, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const email = `product-lead-${owned.id}@factory.invalid`;
    const password = "owned-product-password-not-a-secret";
    const { id: userID } = await serverCall(
      callFactoryFunction(
        owned.base,
        "createAccount",
        [{ name: "Product lead", email, password }],
        { cookie },
      ),
    );
    const teammateEmail = `teammate-${owned.id}@factory.invalid`;
    const teammate = await callFactoryFunction(
      owned.base,
      "createAccount",
      [
        {
          name: "Team developer",
          email: teammateEmail,
          password,
        },
      ],
      { cookie },
    );
    expect(teammate.ok).toBe(true);
    const projectID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`members-${projectID}`},'Team workspace','https://example.invalid/members.git','main','.devcontainer/devcontainer.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${userID},'product-contributor',true,${userID})`;
    const login = await command("/api/auth/sign-in/email", { email, password });
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(
      cookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: owned.base,
      })),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(owned.base);
    await openProjectMenu(page);
    await page.getByRole("button", { name: /Team workspace/ }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const members = page.getByRole("region", { name: "Project membership", exact: true });
    await visible(members).toBeVisible();
    await visible(members.getByLabel("Role for Product lead")).toHaveValue("product-contributor");
    await visible(members.getByLabel("Manage project for Product lead")).toBeChecked();
    await visible(page.getByRole("region", { name: "Managed accounts", exact: true })).toHaveCount(
      0,
    );
    await members.getByLabel("Member email", { exact: true }).fill(teammateEmail);
    await members.getByRole("button", { name: "Add member", exact: true }).click();
    await visible(members.getByLabel("Role for Team developer")).toHaveValue("developer");
    const permission = members.locator('.access-add-member input[name="manageProject"]');
    expect((await permission.boundingBox())?.width).toBeLessThanOrEqual(24);
    await page.screenshot({
      path: ".factory/test-results/enterprise-access/members-desktop.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 430, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: ".factory/test-results/enterprise-access/members-narrow.png",
      animations: "disabled",
    });
    await members.getByLabel("Role for Product lead").selectOption("developer");
    await visible(page.getByRole("alert")).toContainText(
      "Another Project Manager must grant Developer access",
    );
    await page.reload();
    // Reload must restore the same Project and Settings without another selection.
    // Reopening the picker races route restoration and can hide a lost selection.
    await visible(page).toHaveURL(new RegExp(`/projects/${projectID}/settings(?:[/?#]|$)`));
    await visible(members).toContainText("Team workspace");
    await visible(members.getByLabel("Role for Product lead")).toHaveValue("product-contributor");
    await visible(members.getByLabel("Manage project for Product lead")).toBeChecked();
    await visible(members.getByLabel("Role for Team developer")).toHaveValue("developer");
    expect(
      await callFactoryFunction(owned.base, "getRepositoryDocuments", [projectID], { cookie }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await database.client.end({ timeout: 2 });
    await owned.dispose();
  }
}, 60_000);
