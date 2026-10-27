import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import {
  type ReviewFeedback,
  visualReviewSchema,
} from "../../packages/conversation-domain/src/visual-review";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const directory = ".factory/test-results/ticket-planning";
const cache = resolve(".factory/test-results/vite", `ticket-planning-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;
test.setTimeout(45_000);
test.use({ contextOptions: { reducedMotion: "reduce" } });
test.beforeAll(async () => {
  const { stdout } = await promisify(execFile)(
    "mise",
    [
      "exec",
      "--",
      "bun",
      "--no-env-file",
      "-e",
      'import {renderArchitectureDiagrams} from "./apps/factory/src/technical-design/diagrams"; import {planningDesign} from "./test/fixtures/technical-planning"; console.log(JSON.stringify(await renderArchitectureDiagrams(planningDesign)));',
    ],
    { cwd: resolve("."), maxBuffer: 2 * 1024 * 1024 },
  );
  const [svg] = JSON.parse(stdout) as string[];
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    define: { __PLANNING_DIAGRAM__: JSON.stringify(svg) },
    optimizeDeps: { entries: ["ticket-planning.html", "glass-surfaces.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = fixtureValue(
    fixtureValue(server.resolvedUrls, "server.resolvedUrls").local[0],
    "server.resolvedUrls!.local[0]",
  ).replace(/\/$/, "");
  await mkdir(directory, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

test("a prerequisite queues one implementation order and cancellation starts no work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${origin}/ticket-planning.html?prerequisite`);
  const queue = page.getByRole("button", { name: "Queue implementation", exact: true });
  await expect(queue).toBeEnabled();
  await queue.click();
  await expect(page.getByLabel("Ticket progress", { exact: true })).toContainText(
    "Deliver invoice storage",
  );
  await expect(page.getByLabel("Ticket progress", { exact: true })).toContainText(
    "start automatically",
  );
  await expect(queue).toBeHidden();
  await page.screenshot({ path: `${directory}/queued-prerequisite-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel queued implementation", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText("Queued implementation cancelled");
  await expect(page.getByLabel("Fixture commands")).toHaveText(
    JSON.stringify({ work: 1, saves: 0, approvals: 0 }),
  );
  await expect(queue).toBeVisible();
});

for (const width of [1440, 768, 390]) {
  test(`continuous chapters and the real PlantUML render at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${origin}/ticket-planning.html`);
    const ticketDocument = page.getByRole("article", { name: "Ticket document", exact: true });
    await expect(
      ticketDocument.getByRole("heading", { name: "Product", exact: true }),
    ).toBeVisible();
    await expect(ticketDocument.getByRole("tab")).toHaveCount(0);
    await page.screenshot({ path: `${directory}/ticket-${width}.png`, fullPage: true });
    await ticketDocument.getByRole("button", { name: "Add person", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Assign responsibility" });
    await picker.getByRole("searchbox").fill("Lisa");
    await expect(picker.getByRole("button")).toHaveCount(1);
    await page.screenshot({ path: `${directory}/people-${width}.png`, fullPage: true });
    const bounds = await picker.boundingBox();
    if (!bounds) throw new Error("People picker is not visible");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await picker.getByRole("button", { name: "Lisa Product", exact: true }).click();
    await expect(
      ticketDocument.getByRole("button", { name: "Responsible: Lisa Product" }),
    ).toBeFocused();
    await expect(page.getByLabel("Fixture action")).toHaveText("");
    const nav = page.getByRole("navigation", { name: "Ticket chapters" });
    if (width <= 760) await nav.getByLabel("Ticket chapter").selectOption("ticket-architecture");
    else await nav.getByRole("button", { name: "Architecture", exact: true }).click();
    const diagram = page.getByRole("img", { name: /The new export command/ });
    await expect(diagram).toBeVisible();
    expect(
      await diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    await expect(page.getByRole("link", { name: "Open diagram", exact: true })).toHaveAttribute(
      "href",
      /^blob:/,
    );
    await page.screenshot({ path: `${directory}/architecture-${width}.png`, fullPage: true });
    await page.getByText("PlantUML source", { exact: true }).click();
    await expect(page.locator(".ticket-diagram-source code")).toContainText("@startuml");
    await diagram.focus();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`design editing explains its guard and exposes chapter actions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(`${origin}/ticket-planning.html`);
    const technical = page.getByRole("region", { name: "Technical design", exact: true });
    const heading = technical.locator(".ticket-chapter-heading");
    const implement = page.getByRole("button", { name: "Implement", exact: true });
    const navigate = async (chapter: string) => {
      const nav = page.getByRole("navigation", { name: "Ticket chapters" });
      if (width <= 760) await nav.getByLabel("Ticket chapter").selectOption(`ticket-${chapter}`);
      else
        await nav
          .getByRole("button", {
            name: chapter === "technical" ? "Technical design" : "Product",
            exact: true,
          })
          .click();
    };
    await expect(implement).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save design", exact: true })).toHaveCount(0);
    await navigate("technical");
    await heading.getByRole("button", { name: "Edit design", exact: true }).click();
    await expect(implement).toBeDisabled();
    await expect(implement).toHaveAttribute(
      "title",
      "Save or discard your technical design edits.",
    );
    await expect(page.getByText("Editing technical design", { exact: true })).toBeVisible();
    await expect(page.getByText("Ready to implement", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Ticket progress" })).toContainText(
      "Save design or Discard edits in the Technical design chapter",
    );
    const save = heading.getByRole("button", { name: "Save design", exact: true });
    const discard = heading.getByRole("button", { name: "Discard edits", exact: true });
    await expect(save).toBeInViewport();
    await expect(discard).toBeInViewport();
    expect(await save.evaluate((button) => (button as HTMLButtonElement).form?.id)).toBe(
      await technical.locator("form").getAttribute("id"),
    );
    await expect(heading.getByRole("button", { name: "Replan", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${directory}/editing-actions-${width}.png`, fullPage: true });
    const proposed = page.getByLabel("Proposed changes", { exact: true });
    const original = await proposed.inputValue();
    await proposed.fill("A private change that should be discarded, not commissioned.");
    await navigate("product");
    await expect(implement).toBeDisabled();
    await navigate("technical");
    await discard.click();
    await expect(implement).toBeEnabled();
    await expect(page.getByText("Ready to implement", { exact: true })).toBeVisible();
    await expect(page.getByText("Editing technical design", { exact: true })).toHaveCount(0);
    await expect(save).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("ticket-planning:synthetic-user:first:technical"),
      ),
    ).toBeNull();
    await heading.getByRole("button", { name: "Edit design", exact: true }).click();
    await expect(proposed).toHaveValue(original);
    await proposed.fill("Save this human design revision without approving or commissioning work.");
    await navigate("technical");
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Fixture action")).toHaveText("Technical design saved");
    await expect(implement).toBeEnabled();
    await expect(technical.locator(".ticket-design-provenance")).toContainText(
      "Proposed · Revision 2",
    );
    await expect(page.getByLabel("Fixture design approved")).toHaveText("false");
    await expect(page.getByLabel("Fixture commands")).toHaveText(
      JSON.stringify({ work: 0, saves: 1, approvals: 0 }),
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  });
}

test("chapter save preserves form submission and locks actions until the save settles", async ({
  page,
}) => {
  await page.goto(`${origin}/ticket-planning.html?defer-save`);
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  const technical = page.getByRole("region", { name: "Technical design", exact: true });
  const proposed = page.getByLabel("Proposed changes", { exact: true });
  await proposed.fill("Retain this revision while the save is in flight.");
  await page.getByLabel("Diagram 1 title", { exact: true }).press("Enter");
  const saving = technical.getByRole("button", { name: "Saving design…", exact: true });
  await expect(saving).toBeDisabled();
  await expect(
    technical.getByRole("button", { name: "Discard edits", exact: true }),
  ).toBeDisabled();
  await expect(proposed).toBeDisabled();
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
  await technical.locator("form").evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
  });
  await expect(page.getByLabel("Fixture commands")).toHaveText(
    JSON.stringify({ work: 0, saves: 1, approvals: 0 }),
  );
  await page.getByRole("button", { name: "Finish fixture save", exact: true }).click();
  await expect(saving).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
  await expect(page.getByText("Ready to implement", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Fixture design approved")).toHaveText("false");
});

test("technical drafts survive failed saves and are not overwritten by reading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${origin}/ticket-planning.html?fail`);
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  const proposed = page.getByLabel("Proposed changes", { exact: true });
  await proposed.fill("A human-reviewed technical approach that remains in the private draft.");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save design", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is retained");
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(page.getByText("Editing technical design", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Fixture design approved")).toHaveText("false");
  await expect(page.getByLabel("Fixture commands")).toHaveText(
    JSON.stringify({ work: 0, saves: 1, approvals: 0 }),
  );
  await page.screenshot({ path: `${directory}/retained-draft-error.png`, fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await expect(page.getByLabel("Proposed changes", { exact: true })).toHaveValue(
    "A human-reviewed technical approach that remains in the private draft.",
  );
  await page.goto(`${origin}/ticket-planning.html`);
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await page.getByRole("button", { name: "Save design", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText("Technical design saved");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
});

for (const { width, count } of [
  { width: 1440, count: 2 },
  { width: 390, count: 1 },
]) {
  test(`integrated revision action shows ${count} eligible ${count === 1 ? "Thread" : "Threads"} at ${width}px`, async ({
    page,
  }) => {
    const changeID = "10000000-0000-4000-8000-000000000010";
    const feedback = (
      [
        ...Array.from({ length: count }, (_, index) => ({
          kind: "thread" as const,
          state: "open" as const,
          correctionState: index ? ("retry" as const) : null,
        })),
        { kind: "comment", state: "open" },
        { kind: "thread", state: "implemented", correctionState: "sent" },
        { kind: "thread", state: "open", correctionState: "sent" },
        { kind: "thread", state: "resolved" },
      ] satisfies Array<Pick<ReviewFeedback, "kind" | "state" | "correctionState">>
    ).map(
      (item, index): ReviewFeedback => ({
        ...item,
        id: crypto.randomUUID(),
        version: index + 1,
        authorId: "10000000-0000-4000-8000-000000000009",
        author: "Tom Development",
        commitSha: "a".repeat(40),
        annotation: null,
        createdAt: "2026-10-26T10:00:00Z",
        messages: [],
      }),
    );
    const gate = Promise.withResolvers<void>();
    const received: Array<{ commandId: string; feedback: { id: string; version: number }[] }> = [];
    await mockFactoryFunctions(page, {
      review: {
        get: async () =>
          visualReviewSchema.parse({
            feedback,
            recording: null,
            scenarios: [],
            canSendCorrections: true,
          }),
        send: async (_actor, change, input) => {
          expect(change).toBe(changeID);
          received.push(input);
          await gate.promise;
          for (const item of feedback.slice(0, count)) item.correctionState = "running";
          return { turnId: crypto.randomUUID() };
        },
      },
    });
    await page.setViewportSize({ width, height: 960 });
    try {
      await page.goto(`${origin}/ticket-planning.html?review`);
      const label = `${count} ${count === 1 ? "Thread" : "Threads"}`;
      const revision = page.getByRole("button", {
        name: `Request revision · ${label}`,
        exact: true,
      });
      await expect(revision).toBeVisible();
      await expect(revision).toBeEnabled();
      await expect(
        page.getByText(`${count + 2} open Threads block Delivery`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Comments and Threads awaiting recheck are excluded from the revision.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Deliver", exact: true })).toHaveCount(0);
      const nav = page.getByRole("navigation", { name: "Ticket chapters" });
      if (width <= 760) {
        await nav.getByLabel("Ticket chapter").selectOption("ticket-product");
        await nav.getByLabel("Ticket chapter").selectOption("ticket-review");
      } else {
        await nav.getByRole("button", { name: "Product", exact: true }).click();
        await nav.getByRole("button", { name: "Review", exact: true }).click();
      }
      await revision.scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Fixture commands")).toHaveText(
        JSON.stringify({ work: 0, saves: 0, approvals: 0 }),
      );
      expect(received).toHaveLength(0);
      await page.screenshot({ path: `${directory}/revision-count-${width}.png`, fullPage: true });
      await revision.click();
      const sending = page.getByRole("button", {
        name: `Requesting revision… · ${label}`,
        exact: true,
      });
      await expect(sending).toBeDisabled();
      expect(received).toHaveLength(1);
      expect(received[0]?.feedback).toEqual(
        feedback.slice(0, count).map(({ id, version }) => ({ id, version })),
      );
      gate.resolve();
      await expect(sending).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Request revision/ })).toHaveCount(0);
      await expect(
        page.getByText(`${count + 2} open Threads block Delivery`, { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Deliver", exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
    } finally {
      gate.resolve();
    }
  });
}

test("chapter marks expose labels on hover and focus and track manual scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${origin}/ticket-planning.html`);
  const nav = page.getByRole("navigation", { name: "Ticket chapters" });
  const product = nav.getByRole("button", { name: "Product", exact: true });
  const technical = nav.getByRole("button", { name: "Technical design", exact: true });
  await expect(nav.locator(".is-current")).toHaveCount(1);
  await expect(product).toHaveClass("is-current");
  await expect(technical.locator(".ticket-chapter-label")).toBeHidden();
  await technical.hover();
  await expect(technical.locator(".ticket-chapter-label")).toBeVisible();
  await page.screenshot({ path: `${directory}/chapter-hover.png`, fullPage: true });
  await page.mouse.move(1350, 50);
  await technical.focus();
  await expect(technical.locator(".ticket-chapter-label")).toBeVisible();
  const bounds = await technical.boundingBox();
  if (!bounds) throw new Error("Technical chapter control is not visible");
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${directory}/chapter-focus.png`, fullPage: true });
  await page
    .locator("#ticket-technical")
    .evaluate((section) => section.scrollIntoView({ block: "start" }));
  await expect(technical).toHaveAttribute("aria-current", "location");
  await expect(product).toHaveAttribute("aria-current", "false");
  await expect(nav.locator(".is-current")).toHaveCount(1);
  await page
    .locator("#ticket-architecture")
    .evaluate((section) => section.scrollIntoView({ block: "start" }));
  await expect(nav.getByRole("button", { name: "Architecture", exact: true })).toHaveClass(
    "is-current",
  );
  await page.locator(".ticket-workspace").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(nav.getByRole("button", { name: "Validation", exact: true })).toHaveClass(
    "is-current",
  );
  await page
    .locator("#ticket-product")
    .evaluate((section) => section.scrollIntoView({ block: "start" }));
  await expect(product).toHaveClass("is-current");
  await expect(page.getByLabel("Fixture action")).toHaveText("");
});

test("stale scope, contributors and manual tickets keep their authority boundaries", async ({
  page,
}) => {
  await page.goto(`${origin}/ticket-planning.html?stale`);
  await expect(page.getByText("Technical design out of date", { exact: true })).toBeVisible();
  await expect(
    page.getByText("The product specification changed.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Ticket chapters" })
    .getByRole("button", { name: "Technical design", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Update design", exact: true })).toBeInViewport();
  await page.screenshot({ path: `${directory}/stale-design.png`, fullPage: true });
  await page.goto(`${origin}/ticket-planning.html?contributor`);
  await expect(page.getByRole("heading", { name: "Technical design", exact: true })).toHaveCount(0);
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Plan product & tech", exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: `${directory}/contributor-product-only.png`, fullPage: true });
  await page.goto(`${origin}/ticket-planning.html?empty`);
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Plan technical design", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText("Technical planning commissioned");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
  await page
    .getByText("Planning is in progress. Your product specification is retained.", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/technical-planning-pending.png`, fullPage: true });
  await page.goto(`${origin}/ticket-planning.html?empty&unresolved`);
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
  await expect(
    page.getByText("Technical Planning is not complete.", { exact: false }),
  ).toBeVisible();
});

test("chapter controls work from the keyboard and unsafe diagram edits stay in the draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${origin}/ticket-planning.html`);
  const navigation = page.getByRole("navigation", { name: "Ticket chapters" });
  await navigation.getByRole("button", { name: "Product", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    navigation.getByRole("button", { name: "Technical design", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Technical design", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  const source = page.getByLabel("PlantUML source", { exact: true });
  await source.fill("@startuml\n!include private-file\n@enduml");
  await page.getByRole("button", { name: "Save design", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("self-contained PlantUML");
  await expect(source).toHaveValue("@startuml\n!include private-file\n@enduml");
  await page.screenshot({ path: `${directory}/invalid-diagram-draft.png`, fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await expect(page.getByLabel("PlantUML source", { exact: true })).toHaveValue(
    "@startuml\n!include private-file\n@enduml",
  );
});

test("capture the existing Wiki as the visual reference", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${origin}/glass-surfaces.html?surface=wiki`);
  await expect(
    page.getByRole("button", { name: "Edit Knowledge title", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${directory}/existing-wiki-reference.png`, fullPage: true });
});

test("navigation retains each Ticket's technical draft without showing it in another Ticket", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${origin}/ticket-planning.html?switchable`);
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await page
    .getByLabel("Current system", { exact: true })
    .fill("The first Ticket's retained private draft.");
  await page.getByRole("button", { name: "Switch fixture Ticket", exact: true }).click();
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await expect(page.getByLabel("Current system", { exact: true })).toHaveValue(
    "A different Ticket's source context.",
  );
  await page.reload();
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await expect(page.getByLabel("Current system", { exact: true })).toHaveValue(
    "The first Ticket's retained private draft.",
  );
});
