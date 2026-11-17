import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import type { EpicProposal } from "../../packages/conversation-domain/src/epic-proposal";
import { test } from "../fixtures/browser-test";
import {
  correctedHomeCriterion,
  epicNonGoalsKey,
  epicNonGoalsProposal,
} from "../fixtures/epic-proposal-non-goals";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const evidence = ".factory/test-results/epic-proposal-non-goals";
const cache = resolve(".factory/test-results/vite", `epic-non-goals-${crypto.randomUUID()}`);
let server: ViteDevServer, origin: string;
let writes: string[] = [];
test.setTimeout(30_000);
test.use({ reducedMotion: "reduce" });
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["epic-proposal-non-goals.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
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
  writes = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url());
  });
});
test.afterEach(() => {
  expect(writes, "Component edits must make no API/model calls").toEqual([]);
});

async function open(page: Page, query = "") {
  await page.goto(`${origin}/epic-proposal-non-goals.html${query}`);
  await expect(page.getByRole("region", { name: "Proposed Epic", exact: true })).toBeVisible();
  await expect(page.getByText("Loading editor…", { exact: true })).toHaveCount(0);
}
async function submitted(page: Page) {
  return JSON.parse(
    fixtureValue(
      await page.getByLabel("Submitted Epic proposal").textContent(),
      "captured proposal",
    ),
  ) as EpicProposal;
}
async function privateDraft(page: Page, key = epicNonGoalsKey) {
  return page.evaluate((name) => JSON.parse(localStorage.getItem(name) ?? "null"), key);
}

for (const width of [1440, 390]) {
  test(`provided non-goals remain visible, editable and private through confirmation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.screenshot({ path: `${evidence}/proposal-initial-${width}.png` });
    const original = epicNonGoalsProposal();
    const first = fixtureValue(original.members[0], "first fixture member");
    const second = fixtureValue(original.members[1], "second fixture member");
    const firstField = page.getByRole("textbox", { name: "Member 1 non-goal 1", exact: true });
    await expect(firstField).toHaveValue(first.requirement.nonGoals[0] ?? "", { timeout: 3_000 });
    await expect(
      page.getByRole("textbox", { name: "Member 1 non-goal 2", exact: true }),
    ).toHaveValue(first.requirement.nonGoals[1] ?? "");
    await expect(
      page.getByRole("textbox", { name: "Member 2 non-goal 1", exact: true }),
    ).toHaveValue(second.requirement.nonGoals[0] ?? "");
    await expect(
      page.getByRole("textbox", { name: "Member 2 non-goal 2", exact: true }),
    ).toHaveValue(second.requirement.nonGoals[1] ?? "");

    await page
      .getByRole("textbox", { name: "Member 1 criterion 1", exact: true })
      .fill(correctedHomeCriterion);
    await page
      .getByRole("textbox", { name: "Epic title", exact: true })
      .fill("Human-edited welcome improvements");
    const firstEdit =
      "Do not change authentication behavior, routes, dependencies, or unrelated Home copy.";
    const secondEdit = "Do not implement, deploy, or approve Delivery for this planning exercise.";
    await firstField.fill(firstEdit);
    expect(
      await firstField.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeLessThanOrEqual(1);
    await firstField.press("Tab");
    await expect(
      page.getByRole("textbox", { name: "Member 1 non-goal 2", exact: true }),
    ).toBeFocused();
    await page.screenshot({ path: `${evidence}/non-goals-${width}.png` });
    await page.getByRole("textbox", { name: "Member 2 non-goal 2", exact: true }).fill(secondEdit);
    const expected = structuredClone(original);
    expected.epic.title = "Human-edited welcome improvements";
    fixtureValue(expected.members[0], "expected first member").requirement.acceptanceCriteria[0] =
      correctedHomeCriterion;
    fixtureValue(expected.members[0], "expected first member").requirement.nonGoals[0] = firstEdit;
    fixtureValue(expected.members[1], "expected second member").requirement.nonGoals[1] =
      secondEdit;
    await expect.poll(() => privateDraft(page)).toEqual(expected);

    await page.getByRole("button", { name: "Confirm work", exact: true }).click();
    await expect(page.getByLabel("Fixture confirmations")).toHaveText("1");
    expect(await submitted(page)).toEqual(expected);
    expect(await privateDraft(page)).toEqual(expected);
    await open(page, "?accept");
    await expect(firstField).toHaveValue(firstEdit);
    await expect(
      page.getByRole("textbox", { name: "Member 1 criterion 1", exact: true }),
    ).toHaveValue(correctedHomeCriterion);
    await expect(page.getByRole("textbox", { name: "Epic title", exact: true })).toHaveValue(
      expected.epic.title,
    );
    await expect(
      page.getByRole("textbox", { name: "Member 2 non-goal 1", exact: true }),
    ).toHaveValue(second.requirement.nonGoals[0] ?? "");
    await expect(
      page.getByRole("textbox", { name: "Member 2 non-goal 2", exact: true }),
    ).toHaveValue(secondEdit);
    await page.getByRole("button", { name: "Confirm work", exact: true }).click();
    await expect(page.getByLabel("Fixture confirmations")).toHaveText("1");
    expect(await submitted(page)).toEqual(expected);
    await expect.poll(() => privateDraft(page)).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });
}

test("empty non-goal arrays stay empty and show an honest empty group", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "?empty");
  await expect(page.getByRole("heading", { name: "Non-goals", exact: true })).toHaveCount(2);
  await expect(page.getByText("None specified", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: /Member \d+ non-goal \d+/ })).toHaveCount(0);
  await page.getByText("None specified", { exact: true }).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/empty-narrow.png` });
  await page.getByRole("button", { name: "Confirm work", exact: true }).click();
  await expect(page.getByLabel("Fixture confirmations")).toHaveText("1");
  expect((await submitted(page)).members.map((member) => member.requirement.nonGoals)).toEqual([
    [],
    [],
  ]);
});

test("a private non-goal edit stays with its proposal, including prior human corrections", async ({
  page,
}) => {
  await open(page);
  const field = page.getByRole("textbox", { name: "Member 1 non-goal 1", exact: true });
  await field.fill("Keep this exclusion private to the first proposal.");
  await page
    .getByRole("textbox", { name: "Member 1 criterion 1", exact: true })
    .fill(correctedHomeCriterion);
  const retained = await privateDraft(page);
  await open(page, "?other");
  await expect(field).toHaveValue(epicNonGoalsProposal().members[0]?.requirement.nonGoals[0] ?? "");
  await open(page);
  await expect(field).toHaveValue("Keep this exclusion private to the first proposal.");
  await expect(
    page.getByRole("textbox", { name: "Member 1 criterion 1", exact: true }),
  ).toHaveValue(correctedHomeCriterion);
  expect(await privateDraft(page)).toEqual(retained);
  await expect(page.getByLabel("Fixture confirmations")).toHaveText("0");
});
