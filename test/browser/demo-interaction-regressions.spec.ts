import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import {
  browserBootstrap,
  browserFunction,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

let database: ReturnType<typeof createDatabase>;
let projectID: string;
let ticketID: string;

test.beforeEach(async ({ page }) => {
  database = createDatabase(2);
  projectID = crypto.randomUUID();
  ticketID = crypto.randomUUID();
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${`demo-interaction-${projectID.slice(0, 8)}`},'Demo interactions','https://example.invalid/interaction.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
  await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
    VALUES(${projectID},${session.user.id},'developer',true,${session.user.id})`;
  await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
    VALUES(${ticketID},${projectID},'Directly editable product intent','Existing product intent.','inbox',${session.user.id})`;
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "This UI fixture starts no runtime");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "This UI fixture starts no runtime");
      },
    },
  });
  await page.goto(`/projects/${projectID}/tickets/${ticketID}`);
  await expect(page.getByRole("article", { name: "Ticket document" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".workspace-window").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
});

test.afterEach(async () => {
  try {
    await deleteFactoryProject(projectID, database);
  } finally {
    await database.client.end();
  }
});

test("ticket controls stay together and a nonempty document needs no instructional subtitle", async ({
  page,
}) => {
  const document = page.getByRole("article", { name: "Ticket document" });
  const actions = document.getByRole("group", { name: "Ticket actions", exact: true });
  await expect(actions.getByRole("button", { name: "People, add person" })).toBeVisible();
  await expect(
    document.getByRole("button", { name: "Write requirements", exact: true }),
  ).toHaveCount(0);
  await expect(
    document.getByText(
      "Define the intended change and acceptance criteria before commissioning implementation.",
    ),
  ).toHaveCount(0);
  await expect(
    document.getByRole("textbox", { name: "Acceptance criterion 1", exact: true }),
  ).toBeVisible();
});

test("inline requirements save without a mode button, inference or editor remount", async ({
  page,
}) => {
  const document = page.getByRole("article", { name: "Ticket document" });
  const editor = document.getByRole("textbox", { name: "Ticket description", exact: true });
  const criterion = document.getByRole("textbox", { name: "Acceptance criterion 1", exact: true });
  await expect(criterion).toBeVisible();
  await editor.evaluate((e) => e.setAttribute("data-repro-editor", "original"));
  await editor.fill("The product intent can be edited in place.");
  await criterion.fill("The user can type a criterion without switching modes.");
  await expect
    .poll(async () => {
      const [ticket] = await database.client<
        { state: string }[]
      >`SELECT state FROM factory.ticket WHERE id=${ticketID}`;
      return ticket?.state;
    })
    .toBe("ready");
  await expect(editor).toHaveAttribute("data-repro-editor", "original");
  await expect(document.getByText("Ready to implement", { exact: true })).toHaveCount(0);
  await expect(editor).toContainText("The product intent can be edited in place.");
  await expect
    .poll(
      async () =>
        (await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`)
          .length,
    )
    .toBe(0);
  await editor.focus();
  expect(await editor.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  await mkdir(".factory/test-results/demo-interactions", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/demo-interactions/inline-editor-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(criterion).toBeVisible();
  await page.screenshot({
    path: ".factory/test-results/demo-interactions/inline-editor-phone.png",
  });
});

test("a ticket card has no second hover background on its inner button", async ({ page }) => {
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  const card = page
    .locator(".ticket-card-body")
    .filter({ hasText: "Directly editable product intent" });
  await card.hover();
  expect(await card.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
});

test("focused document text has no input box after its focus transition settles", async ({
  page,
}) => {
  const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await editor.focus();
  await editor.evaluate(async (e) => {
    await Promise.all(e.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  await expect(editor).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(editor).toHaveCSS("box-shadow", "none");
});

test("an empty scope chapter does not appear and disappear around autosave", async ({ page }) => {
  const scope = page
    .locator(".specification-block")
    .filter({ has: page.getByRole("heading", { name: "Out of scope", exact: true }) });
  await expect(scope).toBeVisible();
  const title = page.getByRole("textbox", { name: "Ticket title", exact: true });
  await title.fill("Another editable product intent");
  await expect(scope).toBeVisible();
  await expect
    .poll(async () => {
      const [saved] = await database.client<
        { title: string }[]
      >`SELECT title FROM factory.ticket WHERE id=${ticketID}`;
      return saved?.title;
    })
    .toBe("Another editable product intent");
  await expect(scope).toBeVisible();
});

test("original request details are available in overflow without moving the specification", async ({
  page,
}) => {
  const saved = await browserFunction(page, "createRequirementRevision", [
    ticketID,
    {
      summary: "A separately clarified product specification.",
      acceptanceCriteria: ["The original request remains available without taking document space."],
      nonGoals: [],
    },
  ]);
  expect(saved.ok).toBe(true);
  await page.reload();
  const editor = page.getByRole("textbox", { name: "Specification summary", exact: true });
  await expect(editor).toBeVisible();
  await page.locator(".workspace-window").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  const before = await editor.boundingBox();
  await expect(page.locator(".ticket-request-details")).toHaveCount(0);
  const opener = page.getByRole("button", { name: "Ticket actions", exact: true });
  await opener.click();
  await page.getByRole("menuitem", { name: "Request details", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Request details", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Request details", exact: true })).toHaveText(
    "Existing product intent.",
  );
  expect(await editor.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
