import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import type { TicketDetail } from "../../apps/factory/src/desktop/contracts";
import { test } from "../fixtures/browser-test";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import {
  originalTitle,
  otherTitleProjectID,
  otherTitleTicketID,
  savedTitle,
  titleDetail,
  titleProjectID,
  titleRequirement,
  titleTicketID,
} from "../fixtures/ticket-tab-title";
import { fixtureValue } from "../fixtures/value";

const evidence = ".factory/test-results/ticket-tab-title";
const cache = resolve(".factory/test-results/vite", `ticket-tab-title-${crypto.randomUUID()}`);
let server: ViteDevServer, origin: string;
let saved: TicketDetail;
let writes = 0;
type SaveInput = { commandId: string; title: string; proposalEntryId?: string };
let readDetail: (id: string) => Promise<TicketDetail>;
let saveDocument: (id: string, input: SaveInput) => Promise<unknown>;
test.setTimeout(30_000);
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["ticket-tab-title.html"] },
    plugins: [
      {
        name: "isolated-ticket-title-transport",
        enforce: "pre",
        transform(source, id) {
          if (!/\/server-functions\/(tickets|runtime|conversations|delivery|agent)\.ts$/.test(id))
            return;
          // Keep the command/read/state owners real. Only their RPC boundary is
          // doubled, so this component proof needs neither a build nor a database.
          const names = [...source.matchAll(/export const (\w+) = createServerFn/g)].map(
            (match) => match[1],
          );
          return `const call = (name) => async ({data}) => {
            const response = await fetch("/fixture/" + name, {method: "POST", body: JSON.stringify(data)});
            return response.json();
          };\n${names.map((name) => `export const ${name} = call("${name}");`).join("\n")}`;
        },
      },
      factoryFixtureStart(),
      solid({ ssr: false }),
    ],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = fixtureValue(server.resolvedUrls?.local[0], "fixture origin").replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  saved = titleDetail();
  writes = 0;
  readDetail = async (id) => (id === titleTicketID ? saved : titleDetail("Another Ticket", 1, id));
  saveDocument = async (id, input) => {
    expect(id).toBe(titleTicketID);
    writes++;
    saved = {
      ...saved,
      ticket: { ...saved.ticket, title: input.title, version: saved.ticket.version + 1 },
      proposal: null,
    };
    return {
      id: input.commandId,
      ticketVersion: saved.ticket.version,
      requirementRevisionId: null,
    };
  };
  await page.route("**/fixture/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    const [id, input] = route.request().postDataJSON();
    const value =
      name === "getTicketDetail"
        ? await readDetail(id)
        : name === "saveTicketDocument"
          ? await saveDocument(id, input)
          : name === "getChanges"
            ? { changes: [] }
            : name === "getRuntimeAttempts"
              ? { attempts: [] }
              : name === "getProjectPreviews"
                ? { previews: [] }
                : name === "getConversation"
                  ? null
                  : undefined;
    if (value === undefined) throw new Error(`Unexpected fixture RPC: ${name}`);
    await route.fulfill({ json: { ok: true, value } });
  });
});

async function open(page: Page, title = originalTitle, tabsOnly = false) {
  await page.goto(`${origin}/ticket-tab-title.html${tabsOnly ? "?tabs-only" : ""}`);
  await expect(
    tabsOnly
      ? page.getByLabel("Saved fixture Ticket title")
      : page.getByRole("textbox", { name: "Ticket title", exact: true }),
  ).toHaveText(title);
}
const tab = (page: Page, id = titleTicketID) =>
  page.locator(`[role="tab"][id="workspace-tab-${encodeURIComponent(`ticket:${id}`)}"]`);
async function requestRead(page: Page) {
  const completed = Number(await page.getByLabel("Completed fixture reads").textContent());
  await page.getByRole("button", { name: "Read saved Ticket", exact: true }).click();
  return completed + 1;
}
async function finishRead(page: Page, completed: number) {
  await expect(page.getByLabel("Completed fixture reads")).toHaveText(String(completed));
}

test("a human rename updates the open Ticket tab only after the authoritative save read", async ({
  page,
}) => {
  await open(page);
  const received = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  saveDocument = async (_id, input) => {
    writes++;
    received.resolve();
    await release.promise;
    saved = titleDetail(input.title, 2);
    return { id: input.commandId, ticketVersion: 2, requirementRevisionId: null };
  };
  try {
    await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(savedTitle);
    await received.promise;
    await expect(tab(page)).toHaveText(originalTitle);
    release.resolve();
    await expect(tab(page), "Saved Ticket title and its open workspace tab differ").toHaveText(
      savedTitle,
      { timeout: 5_000 },
    );
    await expect(tab(page)).toHaveAttribute("title", savedTitle);
    await expect(tab(page)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toBeFocused();
    await expect(
      page.getByRole("button", { name: `Close ${savedTitle}`, exact: true }),
    ).toHaveCount(1);
    await expect(tab(page, otherTitleTicketID)).toHaveText("Another Ticket");
    await expect(page.getByRole("tab", { name: "My custom IDE label", exact: true })).toHaveCount(
      1,
    );
    expect(writes).toBe(1);
    await page.screenshot({ path: `${evidence}/saved-title-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tab(page)).toHaveText(savedTitle);
    await page.screenshot({ path: `${evidence}/saved-title-narrow.png` });
    const chooser = page.getByRole("button", { name: "Choose an open tab", exact: true });
    await chooser.focus();
    await chooser.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: savedTitle, exact: true })).toBeVisible();
    await page.screenshot({ path: `${evidence}/saved-title-narrow-menu.png` });
    await page.keyboard.press("Escape");
    await expect(chooser).toBeFocused();
  } finally {
    release.resolve();
  }
});

test.describe("touch tab labels", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("the narrow tab chooser uses the authoritative saved title", async ({ page }) => {
    await open(page, originalTitle, true);
    readDetail = async () => titleDetail(savedTitle, 3);
    await finishRead(page, await requestRead(page));
    await expect(tab(page)).toHaveText(savedTitle);
    await page.getByRole("button", { name: "Choose an open tab", exact: true }).tap();
    const selected = page.getByRole("menuitemradio", { name: savedTitle, exact: true });
    await expect(selected).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: `${evidence}/saved-title-touch-menu.png` });
    await selected.tap();
    await expect(page.getByRole("menu", { name: "Open tabs", exact: true })).toHaveCount(0);
    await expect(tab(page)).toHaveAttribute("aria-selected", "true");
    expect(writes).toBe(0);
  });
});

for (const mismatch of ["Ticket", "Project"] as const) {
  test(`a mismatched ${mismatch} response cannot publish a title into any tab`, async ({
    page,
  }) => {
    await open(page, originalTitle, true);
    readDetail = async () =>
      titleDetail(
        savedTitle,
        3,
        mismatch === "Ticket" ? otherTitleTicketID : titleTicketID,
        mismatch === "Project" ? otherTitleProjectID : titleProjectID,
      );
    await finishRead(page, await requestRead(page));
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(tab(page)).toHaveText(originalTitle);
    await expect(tab(page, otherTitleTicketID)).toHaveText("Another Ticket");
    await expect(page.getByLabel("Saved fixture Ticket title")).toHaveText(originalTitle);
    expect(writes).toBe(0);
  });
}

test("private proposal edits leave the saved label until human confirmation is read back", async ({
  page,
}) => {
  const proposalID = "10000000-0000-4000-8000-000000000005";
  saved.proposal = {
    id: proposalID,
    ticket: { title: "AI proposal title, not saved", description: saved.ticket.description },
    requirement: titleRequirement,
    base: { version: 1, documentId: null, revisionId: null },
    fullPlanning: true,
  };
  await open(page, saved.proposal.ticket.title);
  await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(savedTitle);
  await finishRead(page, await requestRead(page));
  await expect(tab(page)).toHaveText(originalTitle);
  expect(writes).toBe(0);
  const save = saveDocument;
  saveDocument = async (id, input) => {
    expect(input.proposalEntryId).toBe(proposalID);
    return save(id, input);
  };
  await page.getByRole("button", { name: "Confirm product spec", exact: true }).click();
  await expect(tab(page)).toHaveText(savedTitle, { timeout: 5_000 });
  expect(saved.ticket.title).toBe(savedTitle);
  expect(writes).toBe(1);
  await expect(page.getByRole("button", { name: "Confirm product spec", exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: `${evidence}/confirmed-proposal-desktop.png` });
});

for (const version of [1, 99]) {
  test(`a superseded read at version ${version} cannot revert the matching Ticket label`, async ({
    page,
  }) => {
    await open(page, originalTitle, true);
    const received = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    readDetail = async () => {
      received.resolve();
      await release.promise;
      return titleDetail("Superseded response title", version);
    };
    try {
      const first = await requestRead(page);
      await received.promise;
      readDetail = async () => titleDetail(savedTitle, 3);
      await finishRead(page, await requestRead(page));
      await expect(tab(page)).toHaveText(savedTitle);
      release.resolve();
      await finishRead(page, first + 1);
      await expect(tab(page)).toHaveText(savedTitle);
      await expect(page.getByLabel("Saved fixture Ticket title")).toHaveText(savedTitle);
      expect(writes).toBe(0);
    } finally {
      release.resolve();
    }
  });
}

test("a late Ticket response cannot rename another selected Ticket or a custom non-Ticket tab", async ({
  page,
}) => {
  await open(page, originalTitle, true);
  const received = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  readDetail = async (id) => {
    if (id !== titleTicketID) return titleDetail("Another Ticket", 1, id);
    received.resolve();
    await release.promise;
    return titleDetail(savedTitle, 3);
  };
  try {
    await requestRead(page);
    await received.promise;
    await tab(page, otherTitleTicketID).click();
    await expect(page.getByLabel("Saved fixture Ticket title")).toHaveText("Another Ticket");
    release.resolve();
    await finishRead(page, 2);
    await expect(tab(page)).toHaveText(originalTitle);
    await expect(tab(page, otherTitleTicketID)).toHaveText("Another Ticket");
    await expect(tab(page, otherTitleTicketID)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "My custom IDE label", exact: true })).toHaveCount(
      1,
    );
  } finally {
    release.resolve();
  }
});

test("a late response stays fenced after switching Projects, even with the same tab identity", async ({
  page,
}) => {
  await open(page, originalTitle, true);
  const received = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  readDetail = async () => {
    received.resolve();
    await release.promise;
    return titleDetail(savedTitle, 3);
  };
  try {
    await requestRead(page);
    await received.promise;
    readDetail = async () =>
      titleDetail("Other Project Ticket", 1, titleTicketID, otherTitleProjectID);
    await page.getByRole("button", { name: "Switch fixture Project", exact: true }).click();
    await expect(tab(page)).toHaveText("Other Project Ticket");
    await expect(page.getByLabel("Saved fixture Ticket title")).toHaveText("Other Project Ticket");
    release.resolve();
    await finishRead(page, 1);
    await expect(tab(page)).toHaveText("Other Project Ticket");
    readDetail = async () => titleDetail(originalTitle, 1, titleTicketID, titleProjectID);
    await page.getByRole("button", { name: "Switch fixture Project", exact: true }).click();
    await expect(tab(page)).toHaveText(originalTitle);
    await expect(page.getByRole("tab", { name: "My custom IDE label", exact: true })).toHaveCount(
      1,
    );
    expect(writes).toBe(0);
  } finally {
    release.resolve();
  }
});
