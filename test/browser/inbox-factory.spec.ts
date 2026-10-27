import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { ownedBrowserEnvironment } from "../fixtures/owned-browser-run";
import { fixtureValue } from "../fixtures/value";

test("the real Factory dock aggregates Projects and opens the exact shared question without commissioning work", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const environment = await ownedBrowserEnvironment();
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/inbox-browser-host.ts"],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let database: ReturnType<typeof createDatabase> | undefined;
  const stopped = new Promise<void>((resolve) => host.once("exit", () => resolve()));
  try {
    const fixture = await new Promise<z.infer<typeof ready>>((resolve, reject) => {
      createInterface({ input: host.stdout }).on("line", (line) => {
        if (line.startsWith("Owned ")) console.info(line);
        if (line.startsWith('{"fixtureBase"')) {
          try {
            resolve(ready.parse(JSON.parse(line)));
          } catch (cause) {
            reject(cause);
          }
        }
      });
      host.once("exit", () => reject(new Error(`Owned Inbox host exited: ${stderr.slice(-2000)}`)));
    });
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = fixture.databaseURL;
    database = createDatabase(2);
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.fixtureBase);
    await page.getByLabel("Email", { exact: true }).fill(`owned-${fixture.id}@factory.local`);
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const [administrator] = await database.client<
      { id: string }[]
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!administrator) throw new Error("Owned Inbox administrator is missing");
    const projects = [crypto.randomUUID(), crypto.randomUUID()];
    const tickets = [crypto.randomUUID(), crypto.randomUUID()];
    const questions = [crypto.randomUUID(), crypto.randomUUID()];
    for (let index = 0; index < 2; index++) {
      const projectID = fixtureValue(projects[index], "projects[index]"),
        ticketID = fixtureValue(tickets[index], "tickets[index]"),
        questionID = fixtureValue(questions[index], "questions[index]");
      const conversationID = crypto.randomUUID();
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`inbox-${projectID}`},${`Inbox proof ${index + 1}`},
          'https://example.invalid/owned-inbox.git','main','.devcontainer/devcontainer.json',${administrator.id})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${administrator.id},'developer',${administrator.id})`;
      await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
        VALUES(${ticketID},${projectID},${`Clarify invoice flow ${index + 1}`},'ready',${administrator.id})`;
      await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
        VALUES(${conversationID},${projectID},${ticketID},'plan',${administrator.id})`;
      await database.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
        VALUES(${questionID},${conversationID},1,'question','project-agent','plan',
          ${`Which customer flow for Project ${index + 1}?`},
          ${JSON.stringify({ question: { type: "free-text", prompt: `Which customer flow for Project ${index + 1}?`, placeholder: "Describe the customer flow" } })}::jsonb)`;
    }
    await expect(
      page.getByRole("button", { name: "Inbox, 2 items need your attention" }),
    ).toBeVisible();
    // Always cross Projects. A random initial Project can otherwise hide snapshot-order bugs.
    await openProjectMenu(page);
    await page
      .getByRole("button")
      .filter({ hasText: `inbox-${projects[0]}` })
      .click();
    await expect(page.getByRole("button", { name: "Open project menu", exact: true })).toHaveText(
      "Inbox proof 1",
    );
    await page.getByRole("button", { name: "Inbox, 2 items need your attention" }).click();
    const inbox = page.getByRole("region", { name: "Personal Inbox" });
    await expect(inbox.getByText("Clarify invoice flow 1", { exact: true })).toBeVisible();
    await expect(inbox.getByText("Clarify invoice flow 2", { exact: true })).toBeVisible();
    await inbox.getByRole("button", { name: /Inbox proof 2.*Answer the Agent/ }).click();
    const question = page.locator(`#conversation-entry-${questions[1]}`);
    await expect(question).toBeFocused();
    await expect(question).toContainText("Which customer flow for Project 2?");
    await expect(page.getByRole("article", { name: "Ticket document", exact: true })).toBeVisible();
    const queue = page.getByRole("navigation", { name: "Inbox queue", exact: true });
    await expect(queue.getByRole("button", { name: "Next item", exact: true })).toBeEnabled();
    await queue.getByRole("button", { name: "Next item", exact: true }).click();
    await expect(page.locator(`#conversation-entry-${questions[0]}`)).toBeFocused();
    await expect(queue.getByRole("button", { name: "Next item", exact: true })).toBeDisabled();
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    await queue.getByRole("button", { name: "Back to Inbox", exact: true }).click();
    await expect(inbox.locator(".inbox-sections .is-current")).toHaveText("Needs you 2");
    await expect(
      inbox.locator(".inbox-open").filter({ hasText: "Clarify invoice flow 1" }),
    ).toBeFocused();
    await inbox
      .getByLabel("Filter Inbox by Project")
      .selectOption(fixtureValue(projects[1], "projects[1]"));
    await inbox.getByRole("button", { name: /Inbox proof 2.*Answer the Agent/ }).click();
    await expect(question).toBeFocused();
    await expect(queue.getByRole("button", { name: "Next item", exact: true })).toBeDisabled();
    await queue.getByRole("button", { name: "Back to Inbox", exact: true }).click();
    await expect(inbox.getByLabel("Filter Inbox by Project")).toHaveValue(
      fixtureValue(projects[1], "projects[1]"),
    );
    await expect(inbox.locator(".inbox-sections .is-current")).toHaveText("Needs you 1");
    await inbox.getByLabel("Filter Inbox by Project").selectOption("");
    await inbox.getByRole("button", { name: /Inbox proof 2.*Answer the Agent/ }).click();
    await expect(question).toBeFocused();
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    const people = page.getByRole("dialog", { name: "Assign responsibility" });
    await expect(people.getByRole("searchbox")).toBeFocused();
    await people.getByRole("button").filter({ hasNotText: "Not assigned" }).click();
    await expect
      .poll(async () => {
        const [row] = await fixtureValue(database, "database").client<{ id: string | null }[]>`
        SELECT user_id AS id FROM factory.ticket_responsibility WHERE ticket_id=${fixtureValue(tickets[1], "tickets[1]")}`;
        return row?.id;
      })
      .toBe(administrator.id);
    await expect
      .poll(async () => {
        const [row] = await fixtureValue(database, "database").client<{ id: string | null }[]>`
        SELECT seen_event_id AS id FROM factory.inbox_receipt
        WHERE user_id=${administrator.id} AND item_id=${`question:${questions[1]}`}`;
        return row?.id;
      })
      .toBe(questions[1]);
    // Reading and assigning responsibility did not answer or commission an Agent.
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    await expect(
      page.getByRole("button", { name: "Inbox, 2 items need your attention" }),
    ).toBeVisible();
    await mkdir(".factory/test-results/inbox", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/inbox/real-factory-question-1440.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Inbox, 2 items need your attention" }).click();
    await expect(inbox).toBeVisible();
    await expect
      .poll(async () =>
        page.getByRole("heading", { name: "Inbox", exact: true }).evaluate((heading) => {
          const bounds = heading.getBoundingClientRect();
          return heading.contains(
            document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
    await expect(inbox.getByRole("listitem")).toHaveCount(2);
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await expect(page.locator(".agent-panel")).toBeVisible();
    await page.getByRole("button", { name: "Inbox, 2 items need your attention" }).click();
    await expect(page.locator(".agent-panel")).not.toBeVisible();
    await expect(inbox).toBeVisible();
    await page.screenshot({
      path: ".factory/test-results/inbox/real-factory-inbox-390.png",
      fullPage: true,
    });
    // A colleague's retained discussion exercises the real personal receipt commands.
    const colleague = crypto.randomUUID(),
      update = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${colleague},'Owned Inbox colleague',${`${colleague}@inbox.test`},true)`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${fixtureValue(projects[0], "projects[0]")},${colleague},'product-contributor',${administrator.id})`;
    const [conversation] = await database.client<{ id: string }[]>`
      SELECT id FROM factory.ticket_conversation WHERE ticket_id=${fixtureValue(tickets[0], "tickets[0]")}`;
    if (!conversation) throw new Error("Owned discussion is missing");
    await database.client`INSERT INTO factory.conversation_entry
      (id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
      VALUES(${update},${conversation.id},2,'user-message','user','plan',
        'Please inspect the empty invoice state.','{"intent":"project-research"}'::jsonb,${colleague})`;
    await expect(
      page.getByRole("button", { name: "Activity 1 unread", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Activity 1 unread", exact: true }).click();
    await inbox
      .getByLabel("Filter Inbox by Project")
      .selectOption(fixtureValue(projects[0], "projects[0]"));
    await inbox.locator(".inbox-open").filter({ hasText: "New Ticket discussion" }).click();
    await expect(page.locator(`#conversation-entry-${update}`)).toBeFocused();
    await page.screenshot({
      path: ".factory/test-results/inbox/real-factory-queue-source-390.png",
      fullPage: true,
    });
    await queue.getByRole("button", { name: "Back to Inbox", exact: true }).click();
    await expect(inbox.getByLabel("Filter Inbox by Project")).toHaveValue(
      fixtureValue(projects[0], "projects[0]"),
    );
    await expect(inbox.locator(".inbox-sections .is-current")).toHaveText("Activity 0 unread");
    const discussion = inbox.locator(".inbox-item").filter({ hasText: "New Ticket discussion" });
    await expect(discussion.locator(".inbox-open")).toBeFocused();
    await page.keyboard.press("u");
    await inbox.getByLabel("Filter Inbox by Project").selectOption("");
    const read = discussion.getByRole("button", { name: "Mark read: New Ticket discussion" });
    await expect(read).toBeEnabled();
    await read.focus();
    await expect(read).toBeFocused();
    await read.press("Enter");
    await expect(
      discussion.getByRole("button", { name: "Mark unread: New Ticket discussion" }),
    ).toBeVisible();
    const receipt = async () =>
      (
        await fixtureValue(database, "database").client<
          { archived: boolean; seen: string | null }[]
        >`
      SELECT archived,seen_event_id AS seen FROM factory.inbox_receipt
      WHERE user_id=${administrator.id} AND item_id=${`conversation:${conversation.id}:original`}`
      )[0];
    await expect.poll(receipt).toEqual({ archived: false, seen: update });
    const archive = discussion.getByRole("button", { name: "Archive: New Ticket discussion" });
    await expect(archive).toBeEnabled();
    await archive.focus();
    await archive.press("Enter");
    await expect.poll(receipt).toEqual({ archived: true, seen: update });
    await expect(
      inbox.getByRole("heading", { name: "No activity yet.", exact: true }),
    ).toBeVisible();
    await inbox.getByRole("button", { name: "Archived", exact: true }).click();
    const restore = inbox.getByRole("button", { name: "Move to Activity: New Ticket discussion" });
    await expect(restore).toBeEnabled();
    await restore.focus();
    await restore.press("Enter");
    await expect.poll(receipt).toEqual({ archived: false, seen: update });
    await expect(
      inbox.getByRole("heading", { name: "No archived activity.", exact: true }),
    ).toBeVisible();
    await inbox.getByRole("button", { name: "Activity 0 unread", exact: true }).click();
    await expect(discussion).toHaveAttribute("data-unread", "false");
    await expect(
      page.getByRole("button", { name: "Inbox, 2 items need your attention" }),
    ).toBeVisible();
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    await page.screenshot({
      path: ".factory/test-results/inbox/real-factory-restored-activity-390.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    await database?.client.end();
    host.kill("SIGTERM");
    await stopped;
  }
});
