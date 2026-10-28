import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { CommandError } from "../../apps/factory/src/command-error";
import type {
  ReviewFeedback,
  VisualReview,
} from "../../packages/conversation-domain/src/visual-review";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const directory = ".factory/test-results/review-triage";
const cache = resolve(".factory/test-results/vite", `review-triage-${crypto.randomUUID()}`);
const threadID = "10000000-0000-4000-8000-000000000010";
const userID = "10000000-0000-4000-8000-000000000006";
let server: ViteDevServer, origin: string;
test.use({ contextOptions: { reducedMotion: "reduce" } });
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["review-triage.html"] },
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

function feedback(messageCount = 5): ReviewFeedback {
  return {
    id: threadID,
    kind: "thread",
    state: "open",
    version: 1,
    authorId: userID,
    author: "Morgan Lee",
    commitSha: "a".repeat(40),
    annotation: null,
    createdAt: "2026-10-26T10:00:00Z",
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: crypto.randomUUID(),
      author: index === 0 ? "Morgan Lee" : "Alex Rivera",
      body:
        index === 0
          ? "Keep the original draft when validation fails."
          : index === messageCount - 1
            ? "Latest reply: the draft is retained, ready to recheck."
            : `Earlier reply ${index}: the validation still needs work.`,
      createdAt: `2026-10-26T10:0${index}:00Z`,
    })),
  };
}

function review(item = feedback()): VisualReview {
  return {
    feedback: [item],
    recording: null,
    currentCommitSha: item.commitSha,
    canSendCorrections: true,
    scenarios: (["passed", "failed", "unverified", null] as const).map((status, index) => ({
      id: `scenario-${index}`,
      title: fixtureValue(
        ["Save a draft", "Reject an empty title", "Interrupted connection", "Resume editing"][
          index
        ],
        '["Save a draft", "Reject an empty title", "Interrupted connection", "Resume editing"][ index ]',
      ),
      category: index === 0 ? "normal" : "error",
      observationKind: "app",
      startedMs: index * 1000,
      endedMs: status ? (index + 1) * 1000 : null,
      status,
      expected: "The entered draft stays visible.",
      observed: status === "passed" ? "The draft was retained." : null,
    })),
  };
}

async function fixture(page: Page, value: VisualReview) {
  const updates: string[] = [];
  await mockFactoryFunctions(page, {
    review: {
      get: async () => structuredClone(value),
      update: async (_actor, _change, input) => {
        const item = fixtureValue(
          value.feedback.find((entry) => entry.id === input.feedbackId),
          "value.feedback.find((entry) => entry.id === input.feedbackId)",
        );
        updates.push(input.action);
        expect(input.expectedVersion).toBe(item.version);
        item.version++;
        if (input.action === "reply") {
          item.messages.push({
            id: crypto.randomUUID(),
            author: "Morgan Lee",
            body: fixtureValue(input.body, "input.body"),
            createdAt: "2026-10-26T10:10:00Z",
          });
        } else item.state = input.action === "resolve" ? "resolved" : "open";
        return { feedbackId: item.id };
      },
    },
  });
  return updates;
}

for (const compact of [false, true]) {
  test(`${compact ? "compact feedback" : "Ticket review"} keeps the first and latest messages visible with keyboard-expandable history`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: compact ? 390 : 1440, height: 960 });
    const value = review();
    const updates = await fixture(page, value);
    await page.goto(
      `${origin}/review-triage.html${compact ? `?compact&feedback=${threadID}` : ""}`,
    );
    const panel = page.getByRole("region", { name: "Visual review", exact: true });
    const thread = panel.getByRole("article", { name: "thread by Morgan Lee", exact: true });
    const earlier = thread.locator(".review-earlier-replies > summary");
    const draft = thread.getByRole("textbox", { name: "Reply to Morgan Lee", exact: true });
    await expect(
      thread.getByText(
        fixtureValue(
          fixtureValue(value.feedback[0], "value.feedback[0]").messages[0],
          "value.feedback[0]!.messages[0]",
        ).body,
      ),
    ).toBeVisible();
    await expect(
      thread.getByText(
        fixtureValue(
          fixtureValue(value.feedback[0], "value.feedback[0]").messages.at(-1),
          "value.feedback[0]!.messages.at(-1)",
        ).body,
      ),
    ).toBeVisible();
    await expect(earlier).toHaveText("3 earlier replies");
    await expect(thread.getByText("Earlier reply 1:", { exact: false })).toBeHidden();
    await expect(thread.getByRole("button", { name: "Resolve Thread", exact: true })).toBeVisible();
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(draft).toBeFocused();
    await draft.fill("Unsent reply stays outside the folded history.");
    await earlier.focus();
    await earlier.press("Enter");
    await expect(thread.getByText("Earlier reply 1:", { exact: false })).toBeVisible();
    fixtureValue(
      fixtureValue(value.feedback[0], "value.feedback[0]").messages[1],
      "value.feedback[0]!.messages[1]",
    ).body = "Earlier reply 1: checked again after refresh.";
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("factory-review-changed", {
          detail: "10000000-0000-4000-8000-000000000003",
        }),
      ),
    );
    await expect(thread.getByText("Earlier reply 1: checked again after refresh.")).toBeVisible();
    await expect(draft).toHaveValue("Unsent reply stays outside the folded history.");
    await earlier.press("Space");
    await expect(thread.getByText("Earlier reply 1:", { exact: false })).toBeHidden();
    await expect(draft).toHaveValue("Unsent reply stays outside the folded history.");
    await page.getByRole("button", { name: "Leave review", exact: true }).click();
    await page.getByRole("button", { name: "Return to review", exact: true }).click();
    await expect(draft).toHaveValue("Unsent reply stays outside the folded history.");
    await draft.fill("Rechecked. The draft survives validation.");
    await thread.getByRole("button", { name: "Add reply", exact: true }).focus();
    await thread.getByRole("button", { name: "Add reply", exact: true }).press("Enter");
    await expect(thread.getByText("Rechecked. The draft survives validation.")).toBeVisible();
    await expect(earlier).toHaveText("4 earlier replies");
    await expect(
      thread.getByText("Latest reply: the draft is retained, ready to recheck.", { exact: true }),
    ).toBeHidden();
    await expect(draft).toHaveCount(0);
    await page.screenshot({
      path: `${directory}/${compact ? "compact" : "ticket"}-collapsed.png`,
      fullPage: true,
    });
    await thread.getByRole("button", { name: "Resolve Thread", exact: true }).click();
    const resolved = panel.locator(".review-resolved");
    await expect(resolved.locator("> summary")).toHaveText("Resolved (1)");
    if (!compact) await resolved.locator("> summary").press("Enter");
    await expect(thread.getByRole("button", { name: "Reopen Thread", exact: true })).toBeVisible();
    await expect(thread.getByText("Rechecked. The draft survives validation.")).toBeVisible();
    await thread.getByRole("button", { name: "Reopen Thread", exact: true }).click();
    await expect(thread.getByRole("button", { name: "Resolve Thread", exact: true })).toBeVisible();
    expect(updates).toEqual(["reply", "resolve", "reopen"]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  });
}

test("short discussions show their only reply without an empty history control", async ({
  page,
}) => {
  const value = review(feedback(2));
  await fixture(page, value);
  await page.goto(`${origin}/review-triage.html?compact&feedback=${threadID}`);
  const thread = page.getByRole("article", { name: "thread by Morgan Lee", exact: true });
  await expect(
    thread.getByText(
      fixtureValue(
        fixtureValue(value.feedback[0], "value.feedback[0]").messages[1],
        "value.feedback[0]!.messages[1]",
      ).body,
    ),
  ).toBeVisible();
  await expect(thread.locator(".review-earlier-replies")).toHaveCount(0);
  fixtureValue(value.feedback[0], "value.feedback[0]").messages.push({
    id: crypto.randomUUID(),
    author: "Morgan Lee",
    body: "One more reply after rechecking.",
    createdAt: "2026-10-26T10:15:00Z",
  });
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("factory-review-changed", {
        detail: "10000000-0000-4000-8000-000000000003",
      }),
    ),
  );
  await expect(thread.locator(".review-earlier-replies > summary")).toHaveText("1 earlier reply");
  await expect(thread.getByText("One more reply after rechecking.")).toBeVisible();
});

test("standalone revision actions show the eligible Thread count and explain the batch scope", async ({
  page,
}) => {
  const value = review();
  await fixture(page, value);
  await page.goto(`${origin}/review-triage.html`);
  const panel = page.getByRole("region", { name: "Visual review", exact: true });
  const single = panel.getByRole("button", { name: "Request revision · 1 Thread", exact: true });
  await expect(single).toBeVisible();
  await expect(single).toHaveAttribute(
    "title",
    "Revise 1 eligible open Thread. Comments and Threads awaiting recheck are excluded.",
  );
  value.feedback.push(
    { ...feedback(), id: crypto.randomUUID() },
    { ...feedback(), id: crypto.randomUUID(), kind: "comment" },
    { ...feedback(), id: crypto.randomUUID(), state: "implemented" },
  );
  await panel.getByRole("button", { name: "Reload review", exact: true }).click();
  const batch = panel.getByRole("button", { name: "Request revision · 2 Threads", exact: true });
  await expect(batch).toBeVisible();
  await expect(batch).toHaveAttribute(
    "title",
    "Revise 2 eligible open Threads. Comments and Threads awaiting recheck are excluded.",
  );
  await page.setViewportSize({ width: 320, height: 960 });
  await expect(batch).toBeVisible();
  await page.screenshot({ path: `${directory}/revision-batch-320.png`, fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  fixtureValue(value.feedback[1], "value.feedback[1]").state = "resolved";
  await panel.getByRole("button", { name: "Reload review", exact: true }).click();
  await expect(single).toBeVisible();
});

test("scenario outcomes remain distinguishable without color at desktop and narrow widths", async ({
  page,
}) => {
  await fixture(page, review());
  await page.goto(`${origin}/review-triage.html`);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    const scenarios = page.getByRole("group", { name: "QA scenarios", exact: true });
    for (const [status, title] of [
      ["Passed", "Save a draft"],
      ["Failed", "Reject an empty title"],
      ["Unverified", "Interrupted connection"],
      ["Unfinished", "Resume editing"],
    ]) {
      const scenario = scenarios.getByRole("button", { name: `${status} ${title}`, exact: true });
      await expect(
        scenario.getByText(fixtureValue(status, "status"), { exact: true }),
      ).toBeVisible();
      await scenario.click();
      await expect(scenario).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("definition").filter({ hasText: "The entered draft" }),
      ).toBeVisible();
    }
    await page.screenshot({ path: `${directory}/scenarios-${width}.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  }
});

for (const externalActions of [false, true]) {
  test(`${externalActions ? "external" : "standalone"} Add feedback waits for a usable review and recovers after a failed load`, async ({
    page,
  }) => {
    const pending = Promise.withResolvers<void>();
    let unavailable = true;
    let reads = 0;
    await mockFactoryFunctions(page, {
      review: {
        get: async () => {
          reads++;
          await pending.promise;
          if (unavailable) throw new CommandError("unavailable", "Owned review read unavailable");
          return review();
        },
      },
    });
    await page.goto(`${origin}/review-triage.html${externalActions ? "?external-actions" : ""}`);
    const add = page.getByRole("button", { name: "Add feedback", exact: true });
    await expect(page.getByRole("status").filter({ hasText: "Loading review" })).toBeVisible();
    if (externalActions) await expect(add).toHaveCount(0);
    else {
      await expect(add).toBeDisabled();
      await expect(add).toHaveAttribute("title", "Wait for review to load before adding feedback.");
    }
    pending.resolve();
    await expect(page.getByRole("alert")).toContainText("Review could not load.");
    await expect(
      page.getByRole("status").filter({ hasText: "Reload review before adding feedback." }),
    ).toBeVisible();
    if (externalActions) await expect(add).toHaveCount(0);
    else {
      await expect(add).toBeDisabled();
      await expect(add).toHaveAttribute("title", "Reload review before adding feedback.");
    }
    unavailable = false;
    await page.getByRole("button", { name: "Reload review", exact: true }).click();
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByRole("textbox", { name: "Review comment", exact: true })).toBeFocused();
    expect(reads).toBeGreaterThanOrEqual(2);
  });
}

test("Add feedback also opens a composer when the Ticket was linked to an existing Thread", async ({
  page,
}) => {
  await fixture(page, review());
  await page.goto(`${origin}/review-triage.html?feedback=${threadID}`);
  await page.getByRole("button", { name: "Add feedback", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Review comment", exact: true })).toBeFocused();
});

test("the compact Preview composer stays locked until review loads and retains its draft on return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pending = Promise.withResolvers<void>();
  await mockFactoryFunctions(page, {
    review: {
      get: async () => {
        await pending.promise;
        return review();
      },
    },
  });
  await page.goto(`${origin}/review-triage.html?compact`);
  const comment = page.getByRole("textbox", { name: "Review comment", exact: true });
  await expect(comment).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save feedback", exact: true })).toBeDisabled();
  pending.resolve();
  await expect(comment).toBeFocused();
  await comment.fill("A Preview draft must survive leaving this view.");
  await page.getByRole("combobox", { name: "Feedback type", exact: true }).selectOption("thread");
  await page.getByRole("button", { name: "Leave review", exact: true }).click();
  await page.getByRole("button", { name: "Return to review", exact: true }).click();
  await expect(comment).toHaveValue("A Preview draft must survive leaving this view.");
  await expect(page.getByRole("combobox", { name: "Feedback type", exact: true })).toHaveValue(
    "thread",
  );
  await page.screenshot({ path: `${directory}/compact-composer.png`, fullPage: true });
});

test("compact read-only comments retain their complete expandable discussion without Thread actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const item = feedback();
  item.kind = "comment";
  const value = review(item);
  value.readOnly = true;
  await fixture(page, value);
  await page.goto(`${origin}/review-triage.html?compact&feedback=${threadID}`);
  const comment = page.getByRole("article", { name: "comment by Morgan Lee", exact: true });
  await expect(
    comment.getByText(fixtureValue(item.messages[0], "item.messages[0]").body),
  ).toBeVisible();
  await expect(
    comment.getByText(fixtureValue(item.messages.at(-1), "item.messages.at(-1)").body),
  ).toBeVisible();
  await comment.locator(".review-earlier-replies > summary").press("Enter");
  await expect(comment.getByText("Earlier reply 1:", { exact: false })).toBeVisible();
  await expect(comment.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
  await expect(comment.getByRole("button", { name: "Resolve Thread", exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${directory}/compact-read-only.png`, fullPage: true });
});
