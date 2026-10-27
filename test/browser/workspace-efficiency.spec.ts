import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { createPlanningEpic } from "../support/factory-fixture";
import { ownedBrowserEnvironment } from "../fixtures/owned-browser-run";

const evidence = ".factory/test-results/workspace-efficiency";

test("workspace focus and Ticket quick-find preserve keyboard access and commission no work", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/browser-console.log`, "");
  const environment = await ownedBrowserEnvironment();
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/inbox-browser-host.ts"],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const stopped = new Promise<void>((resolve) => host.once("exit", () => resolve()));
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const fixture = await new Promise<z.infer<typeof ready>>((resolve, reject) => {
      createInterface({ input: host.stdout }).on("line", (line) => {
        if (line.startsWith("Owned ")) console.info(line);
        if (line.startsWith('{"fixtureBase"')) {
          try {
            resolve(ready.parse(JSON.parse(line)));
          } catch (error) {
            reject(error);
          }
        }
      });
      host.once("exit", () => reject(new Error(`Owned host exited: ${stderr.slice(-2000)}`)));
    });
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = fixture.databaseURL;
    database = createDatabase(2);
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        void writeFile(`${evidence}/browser-console.log`, `${message.text()}\n`, { flag: "a" });
    });
    const [administrator] = await database.client<
      { id: string }[]
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!administrator) throw new Error("Owned administrator is missing");
    const projectID = crypto.randomUUID();
    const nestedID = crypto.randomUUID();
    const historyID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project
      (id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`efficiency-${projectID}`},'Workspace efficiency',
        'https://example.invalid/efficiency.git','main','.devcontainer/devcontainer.json',${administrator.id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${projectID},${administrator.id},'developer',${administrator.id})`;
    const epicID = await createPlanningEpic({
      database,
      projectID,
      userID: administrator.id,
      title: "Billing",
    });
    await database.client`INSERT INTO factory.ticket
      (id,project_id,title,state,epic_id,created_by)
      VALUES(${nestedID},${projectID},'Keep an interrupted invoice draft','ready',${epicID},${administrator.id}),
        (${historyID},${projectID},'Archived invoice export','done',NULL,${administrator.id})`;
    for (let index = 0; index < 12; index++)
      await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
        VALUES(${crypto.randomUUID()},${projectID},${`Prepare billing detail ${index + 1}`},'ready',${administrator.id})`;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(fixture.fixtureBase);
    await page.getByLabel("Email", { exact: true }).fill(`owned-${fixture.id}@factory.local`);
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await openProjectMenu(page);
    const projectChoice = page.getByRole("button").filter({ hasText: `efficiency-${projectID}` });
    await expect(projectChoice).toBeVisible();
    await projectChoice.click();
    await expect(
      page.getByRole("button", { name: "Open Epic Billing", exact: true }),
    ).toBeVisible();

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      const create = page.getByRole("button", { name: "New Ticket", exact: true });
      await create.focus();
      await create.press("Enter");
      const title = page.getByLabel("Ticket title", { exact: true });
      await expect(title).toBeFocused();
      await title.fill("Retain my local draft");
      const board = page.locator(".kanban-desktop");
      await expect(board).toHaveAttribute("inert", "");
      // Background cards must not re-enter sequential navigation.
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press("Tab");
        expect(await board.evaluate((element) => element.contains(document.activeElement))).toBe(
          false,
        );
      }
      await page.screenshot({ path: `${evidence}/draft-focus-${width}.png` });
      await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
      await expect(create).toBeFocused();
      await writeFile(
        `${evidence}/focus-return-${width}.json`,
        JSON.stringify(
          await page.evaluate(() => ({
            active: document.activeElement?.getAttribute("aria-label"),
          })),
          null,
          2,
        ),
      );
      await create.press("Enter");
      await expect(title).toBeFocused();
      await expect(title).toHaveValue("Retain my local draft");
      await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
      if (width === 1440) {
        await create.press("Enter");
        await expect(title).toBeFocused();
        await page
          .getByRole("button", { name: "Close Retain my local draft", exact: true })
          .click();
        await expect(create).toBeFocused();
      }

      const find = page.getByRole("button", { name: "Find Ticket", exact: true });
      await find.focus();
      await find.press("Enter");
      const search = page.getByRole("dialog", { name: "Find Ticket", exact: true });
      const input = search.getByRole("searchbox", { name: "Find Ticket by title or reference" });
      await expect(input).toBeFocused();
      await input.fill("interrupted invoice");
      const result = search.getByRole("button", { name: /Keep an interrupted invoice draft/ });
      await expect(search.getByRole("button")).toHaveCount(1);
      await input.press("ArrowDown");
      await expect(result).toBeFocused();
      await page.screenshot({ path: `${evidence}/quick-find-${width}.png` });
      await result.press("Enter");
      const ticketDocument = page.getByRole("article", { name: "Ticket document", exact: true });
      await expect(ticketDocument).toBeFocused();
      await expect(
        ticketDocument.getByRole("textbox", { name: "Ticket title", exact: true }),
      ).toHaveText("Keep an interrupted invoice draft");
      await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
      await expect(find).toBeFocused();
      await find.press("Enter");
      await expect(input).toHaveValue("");
      await input.fill(historyID.replaceAll("-", "").slice(0, 6));
      await expect(search.getByRole("button")).toHaveCount(1);
      await expect(search.getByRole("button")).toContainText("Archived invoice export");
      await input.fill("no matching invoice");
      await expect(search.getByRole("button")).toHaveCount(0);
      await expect(search.getByRole("status")).toContainText("No matching Tickets");
      await input.press("ArrowDown");
      await expect(input).toBeFocused();
      await input.press("Escape");
      await expect(search).toBeHidden();
      await expect(find).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
    }
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await writeFile(
      `${evidence}/final-focus.json`,
      JSON.stringify(
        await page
          .evaluate(() => ({
            active: document.activeElement?.getAttribute("aria-label"),
          }))
          .catch(() => null),
        null,
        2,
      ),
    );
    await writeFile(`${evidence}/host-stderr.log`, stderr);
    await database?.client.end();
    host.kill("SIGTERM");
    await stopped;
  }
});
