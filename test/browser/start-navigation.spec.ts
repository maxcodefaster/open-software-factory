import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { expect } from "@playwright/test";
import { z } from "zod";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { ownedBrowserEnvironment } from "../fixtures/owned-browser-run";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserFunction, factoryFunctionMatcher } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";

test("Start deep links preserve login destinations, history, private drafts and authorization", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(240_000);
  const evidence = ".factory/test-results/start-navigation";
  await mkdir(evidence, { recursive: true });
  const previousBuild = process.env["FACTORY_BUILD_DIRECTORY"];
  const env = await ownedBrowserEnvironment();
  const build = env.FACTORY_BUILD_DIRECTORY;
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/inbox-browser-host.ts"],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  host.stderr.on("data", (chunk) => {
    log += String(chunk);
  });
  const stopped = new Promise<void>((resolve) => host.once("exit", () => resolve()));
  let database: ReturnType<typeof createDatabase> | undefined;
  let development: ReturnType<typeof spawn> | undefined;
  let developmentStopped: Promise<void> | undefined;
  try {
    process.env["FACTORY_BUILD_DIRECTORY"] = build;
    const schema = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
    const fixture = await new Promise<z.infer<typeof schema>>((resolve, reject) => {
      createInterface({ input: host.stdout }).on("line", (line) => {
        log += `${line}\n`;
        if (line.startsWith('{"fixtureBase"')) {
          try {
            resolve(schema.parse(JSON.parse(line)));
          } catch (cause) {
            reject(cause);
          }
        }
      });
      host.once("exit", () => reject(new Error(`Owned Start host exited: ${log.slice(-3000)}`)));
    });
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = fixture.databaseURL;
    database = createDatabase(2);
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
    const [administrator] = await database.client<
      { id: string }[]
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!administrator) throw new Error("Owned administrator is missing");
    const projects = [crypto.randomUUID(), crypto.randomUUID()];
    const tickets = [crypto.randomUUID(), crypto.randomUUID()];
    const wiki = [crypto.randomUUID(), crypto.randomUUID()];
    for (let index = 0; index < 2; index++) {
      const project = fixtureValue(projects[index], "projects[index]"),
        ticket = fixtureValue(tickets[index], "tickets[index]"),
        pageID = fixtureValue(wiki[index], "wiki[index]");
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${project},${`navigation-${project}`},${`Navigation Project ${index + 1}`},
          'https://example.invalid/navigation.git','main','.devcontainer/devcontainer.json',${administrator.id})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${project},${administrator.id},'developer',${administrator.id})`;
      await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
        VALUES(${ticket},${project},${`Shared Ticket ${index + 1}`},'ready',${administrator.id})`;
      await database.client`INSERT INTO factory.knowledge_page
        (id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
        VALUES(${pageID},${project},'overview',${`Shared Wiki ${index + 1}`},${`Wiki body ${index + 1}`},
          ${`Wiki body ${index + 1}`},${"a".repeat(40)},${administrator.id})`;
    }
    const ticketURL = `${fixture.fixtureBase}/projects/${projects[0]}/tickets/${tickets[0]}`;
    const otherTicketURL = `${fixture.fixtureBase}/projects/${projects[1]}/tickets/${tickets[1]}`;
    const wikiURL = `${fixture.fixtureBase}/projects/${projects[0]}/wiki/${wiki[0]}`;
    const errors: string[] = [];
    const diagnostics: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      log += `Page error: ${error.stack}\n`;
    });
    page.on("console", (message) => {
      if (
        /\[(STRICT_READ_UNTRACKED|NO_OWNER_CLEANUP|REACTIVE_WRITE_IN_OWNED_SCOPE)\]/.test(
          message.text(),
        )
      )
        diagnostics.push(message.text());
      if (message.type() === "error") {
        log += `Browser console: ${message.text()}\n`;
        if (/ReferenceError|Cannot access .* before initialization/.test(message.text()))
          errors.push(message.text());
      }
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    let interrupted = false;
    await page.route(await factoryFunctionMatcher("getBootstrap"), async (route) => {
      if (!interrupted) {
        interrupted = true;
        await route.abort("connectionfailed");
      } else await route.continue();
    });
    await page.goto(ticketURL);
    await page.getByRole("button", { name: "Retry opening Factory", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill(`owned-${fixture.id}@factory.local`);
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const title = page
      .getByRole("article", { name: "Ticket document", exact: true })
      .getByRole("textbox", { name: "Ticket title", exact: true });
    await expect(title).toHaveText("Shared Ticket 1");
    await expect(page).toHaveURL(ticketURL);
    const head = await page.request.head(ticketURL, { headers: { accept: "text/html" } });
    expect(head.status()).toBe(200);
    expect(head.headers()["cache-control"]).toBe("no-store");
    expect(await head.body()).toHaveLength(0);
    const copyLink = page.getByRole("button", { name: "Copy link", exact: true });
    await expect(copyLink).toBeVisible();
    await expect(copyLink).toHaveAttribute("title", "Copy link");
    await expect(copyLink).toHaveText("");
    await expect(copyLink).toHaveClass(/workspace-action/);
    await page.screenshot({ path: `${evidence}/copy-link-1440.png`, fullPage: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await copyLink.click();
    await expect(copyLink).toHaveAttribute("data-feedback", "success");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ticketURL);
    await page.screenshot({ path: `${evidence}/ticket-1440.png`, fullPage: true });
    await page.reload();
    await expect(title).toHaveText("Shared Ticket 1");
    await expect(page).toHaveURL(ticketURL);
    const another = await context.newPage();
    await another.goto(ticketURL);
    await expect(
      another
        .getByRole("article", { name: "Ticket document", exact: true })
        .getByRole("textbox", { name: "Ticket title", exact: true }),
    ).toHaveText("Shared Ticket 1");
    await another.close();

    // The persistent root must survive both resource and Project changes.
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await page.getByLabel("Ticket title", { exact: true }).fill("Unpublished local writing");
    await page.getByRole("tab", { name: "Shared Ticket 1", exact: true }).click();
    await expect(page).toHaveURL(ticketURL);
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await openProjectMenu(page);
    await page
      .getByRole("button")
      .filter({ hasText: `navigation-${projects[1]}` })
      .click();
    await page.locator(".ticket-card-body").filter({ hasText: "Shared Ticket 2" }).click();
    await expect(page).toHaveURL(otherTicketURL);
    await expect(title).toHaveText("Shared Ticket 2");
    await page.goBack(); // Project 2 Board
    await expect(page).toHaveURL(`${fixture.fixtureBase}/projects/${projects[1]}`);
    await page.goBack();
    await expect(page).toHaveURL(ticketURL);
    await expect(title).toHaveText("Shared Ticket 1");
    await expect(
      page.getByRole("tab", { name: "Unpublished local writing", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Unpublished local writing", exact: true }).click();
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
      "Unpublished local writing",
    );
    await page.goBack();
    await expect(title).toHaveText("Shared Ticket 1");
    await page.goForward();
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
      "Unpublished local writing",
    );
    expect(
      await database.client`SELECT id FROM factory.ticket WHERE title='Unpublished local writing'`,
    ).toHaveLength(0);

    await page.goto(wikiURL);
    await expect(page.getByText("Wiki body 1", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(wikiURL);
    await page.reload();
    await expect(page.getByText("Wiki body 1", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);

    // A resource URL carries identity, not permission. Recheck live membership.
    const email = `${crypto.randomUUID()}@navigation.test`;
    const password = "owned-navigation-password-not-a-secret";
    const colleague = z
      .object({ id: z.uuid() })
      .parse(
        await serverCall(
          browserFunction(page, "createAccount", [{ name: "Link recipient", email, password }]),
        ),
      );
    const recipientContext = await browser.newContext();
    try {
      const recipient = await recipientContext.newPage();
      await recipient.emulateMedia({ reducedMotion: "reduce" });
      await recipient.goto(ticketURL);
      await recipient.getByLabel("Email", { exact: true }).fill(email);
      await recipient.getByLabel("Password", { exact: true }).fill(password);
      await recipient.getByRole("button", { name: "Sign in", exact: true }).click();
      const unavailable = recipient.getByText(
        "This link is unavailable. You may not have access, or the item was removed.",
        { exact: true },
      );
      await expect(unavailable).toBeVisible();
      await expect(
        recipient.getByRole("article", { name: "Ticket document", exact: true }),
      ).toHaveCount(0);
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${fixtureValue(projects[0], "projects[0]")},${colleague.id},'product-contributor',${administrator.id})`;
      await expect(
        recipient.getByRole("article", { name: "Ticket document", exact: true }),
      ).toBeVisible();
      await recipient.goto(wikiURL);
      await expect(recipient.getByText("Wiki body 1", { exact: true })).toBeVisible();
      await recipient.setViewportSize({ width: 390, height: 844 });
      await expect(recipient.getByText("Wiki body 1", { exact: true })).toBeInViewport();
      await expect
        .poll(() =>
          recipient
            .locator(".workspace-window")
            .evaluate((window) => Math.round(window.getBoundingClientRect().width)),
        )
        .toBeGreaterThan(350);
      await expect(recipient.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
      await recipient.screenshot({ path: `${evidence}/wiki-390.png`, fullPage: true });
      await recipient.goto(ticketURL);
      await expect(
        recipient.getByRole("article", { name: "Ticket document", exact: true }),
      ).toBeVisible();
      await database.client`DELETE FROM factory.project_membership WHERE project_id=${fixtureValue(projects[0], "projects[0]")} AND user_id=${colleague.id}`;
      await expect(unavailable).toBeVisible();
      await expect(
        recipient.getByRole("article", { name: "Ticket document", exact: true }),
      ).not.toBeVisible();
    } finally {
      await recipientContext.close();
    }

    for (const path of [
      `/projects/${projects[0]}/tickets/${tickets[1]}`,
      `/projects/${projects[0]}/tickets/${crypto.randomUUID()}`,
      `/projects/${crypto.randomUUID()}/tickets/${tickets[0]}`,
      `/projects/${projects[0]}/wiki/${wiki[1]}`,
      `/projects/${projects[0]}/tickets/not-a-uuid`,
    ]) {
      await page.goto(`${fixture.fixtureBase}${path}`);
      await expect(
        page.getByText(
          "This link is unavailable. You may not have access, or the item was removed.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page
          .getByRole("textbox", { name: "Ticket title", exact: true })
          .filter({ hasText: "Shared Ticket 2" }),
      ).toHaveCount(0);
      await expect(page.getByText("Wiki body 2", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Copy link", exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: `${evidence}/unavailable-390.png`, fullPage: true });
    development = spawn(
      "mise",
      ["exec", "--", "bun", "--no-env-file", "test/fixtures/start-development-host.ts"],
      {
        env: { ...env, FACTORY_DEV_BACKEND_URL: fixture.fixtureBase },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const dev = development;
    developmentStopped = new Promise<void>((resolve) => dev.once("exit", () => resolve()));
    dev.stderr?.on("data", (chunk) => {
      log += String(chunk);
    });
    const developmentBase = await new Promise<string>((resolve, reject) => {
      createInterface({ input: fixtureValue(dev.stdout, "dev.stdout") }).on("line", (line) => {
        log += `${line}\n`;
        if (line.startsWith('{"developmentBase"')) {
          try {
            resolve(z.object({ developmentBase: z.url() }).parse(JSON.parse(line)).developmentBase);
          } catch (cause) {
            reject(cause);
          }
        }
      });
      dev.once("exit", () => reject(new Error("Owned Start development server stopped")));
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${developmentBase}${new URL(ticketURL).pathname}`);
    await expect(title).toHaveText("Shared Ticket 1");
    await page.reload();
    await expect(title).toHaveText("Shared Ticket 1");
    await page.screenshot({ path: `${evidence}/development-ticket-1440.png`, fullPage: true });
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    expect(await database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(diagnostics).toEqual([]);
  } finally {
    if (!page.isClosed())
      await page.screenshot({ path: `${evidence}/last-state.png`, fullPage: true }).catch(() => {});
    // Close the planning WebSocket before awaiting Vite's HTTP proxy shutdown.
    // Otherwise an interrupted test can strand both owned backend and database.
    await page.close().catch(() => {});
    development?.kill("SIGTERM");
    await developmentStopped;
    await database?.client.end();
    host.kill("SIGTERM");
    await stopped;
    await writeFile(`${evidence}/host.log`, log);
    if (previousBuild === undefined) delete process.env["FACTORY_BUILD_DIRECTORY"];
    else process.env["FACTORY_BUILD_DIRECTORY"] = previousBuild;
  }
});
