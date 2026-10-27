import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { type WriterView, writerViewSchema } from "../../apps/factory/src/api-contracts";
import { CommandError } from "../../apps/factory/src/command-error";
import { visualReviewSchema } from "../../packages/conversation-domain/src/visual-review";
import { factoryFunctionMatches, mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const cache = resolve(".factory/test-results/vite", `writer-transport-${crypto.randomUUID()}`);
const directory = ".factory/test-results/writer-transport";
let server: ViteDevServer, origin: string;
test.setTimeout(60_000);
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["writer-status.html", "review-transport.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
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
const initial = () =>
  writerViewSchema.parse({
    state: "human",
    epoch: 3,
    canWrite: false,
    yours: false,
    commandID: null,
    actor: {
      kind: "human",
      user: { id: "10000000-0000-4000-8000-000000000004", name: "Anna" },
      delegated: false,
      workState: null,
    },
    requester: null,
  });
const requested = () =>
  writerViewSchema.parse({
    ...initial(),
    requests: [
      {
        id: "10000000-0000-4000-8000-000000000005",
        epoch: 3,
        requester: { id: "10000000-0000-4000-8000-000000000006", name: "You" },
      },
    ],
  });

test("Writer ignores a delayed pre-command status after the exact editing request succeeds", async ({
  page,
}) => {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<WriterView>();
  let reads = 0,
    view = initial();
  await mockFactoryFunctions(page, {
    writer: {
      async status() {
        if (++reads === 2) {
          started.resolve();
          return release.promise;
        }
        return view;
      },
      async request(_actor, _change, input) {
        expect(input.epoch).toBe(3);
        view = requested();
        return view;
      },
    },
  });
  await page.goto(`${origin}/writer-status.html`);
  await expect(page.getByRole("button", { name: "Request editing", exact: true })).toBeVisible();
  await started.promise;
  await page.getByRole("button", { name: "Request editing", exact: true }).click();
  await expect(page.getByText("Editing requested", { exact: true })).toBeVisible();
  const observed = page.waitForResponse(
    async (response) => await factoryFunctionMatches(response.url(), "getChangeWriterStatus"),
  );
  release.resolve(initial());
  await observed;
  await expect(page.getByText("Editing requested", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request editing", exact: true })).toHaveCount(0);
});

test("Writer explicitly retries an unconfirmed editing request with the same command identity", async ({
  page,
}) => {
  const commands: Array<{ commandID: string; epoch: number }> = [];
  let view = initial();
  await mockFactoryFunctions(page, {
    writer: {
      status: async () => view,
      async request(_actor, _change, input) {
        commands.push(input);
        if (commands.length === 1)
          throw new CommandError("unavailable", "Editing request is unconfirmed");
        view = requested();
        return view;
      },
    },
  });
  await page.goto(`${origin}/writer-status.html`);
  const button = page.getByRole("button", { name: "Request editing", exact: true });
  await button.click();
  await expect(page.getByRole("alert")).toContainText("unconfirmed");
  expect(commands).toHaveLength(1);
  await button.click();
  await expect(page.getByText("Editing requested", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  await page.screenshot({ path: `${directory}/request-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/request-narrow.png`, fullPage: true });
});

test("Writer continues admitted work while hidden without publishing its late result into a reopened status", async ({
  page,
}) => {
  const admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<WriterView>();
  let view = initial(),
    commands = 0;
  await mockFactoryFunctions(page, {
    writer: {
      status: async () => view,
      async request() {
        commands++;
        admitted.resolve();
        return release.promise;
      },
    },
  });
  await page.goto(`${origin}/writer-status.html`);
  await page.getByRole("button", { name: "Request editing", exact: true }).click();
  await admitted.promise;
  await page.getByRole("button", { name: "Hide writing status", exact: true }).click();
  view = writerViewSchema.parse({ ...initial(), epoch: 4, canWrite: true, yours: true });
  await page.getByRole("button", { name: "Show writing status", exact: true }).click();
  await expect(page.getByRole("button", { name: "Release editing", exact: true })).toBeVisible();
  const observed = page.waitForResponse(
    async (response) => await factoryFunctionMatches(response.url(), "requestChangeEditing"),
  );
  release.resolve(requested());
  await observed;
  await expect(page.getByRole("button", { name: "Release editing", exact: true })).toBeVisible();
  await expect(page.getByLabel("Published writer epoch")).toHaveText("4");
  expect(commands).toBe(1);
});

test("Review publishes its completed post-save read even when another poll tick occurs", async ({
  page,
}) => {
  const empty = visualReviewSchema.parse({
    recording: null,
    scenarios: [],
    feedback: [],
  });
  const saved = visualReviewSchema.parse({
    ...empty,
    feedback: [
      {
        id: "10000000-0000-4000-8000-000000000007",
        kind: "thread",
        state: "open",
        version: 1,
        authorId: "10000000-0000-4000-8000-000000000006",
        author: "You",
        commitSha: "a".repeat(40),
        annotation: null,
        createdAt: "2026-10-24T00:00:00.000Z",
        messages: [
          {
            id: "10000000-0000-4000-8000-000000000008",
            author: "You",
            body: "Retain this draft.",
            createdAt: "2026-10-24T00:00:00.000Z",
          },
        ],
      },
    ],
  });
  let created = false;
  const readStarted = Promise.withResolvers<void>();
  const gates: ReturnType<typeof Promise.withResolvers<typeof saved>>[] = [];
  await mockFactoryFunctions(page, {
    review: {
      async get() {
        if (!created) return empty;
        const gate = Promise.withResolvers<typeof saved>();
        gates.push(gate);
        readStarted.resolve();
        return gate.promise;
      },
      async create() {
        created = true;
        return { feedbackId: fixtureValue(saved.feedback[0], "saved.feedback[0]").id };
      },
    },
  });
  await page.clock.install();
  try {
    await page.goto(`${origin}/review-transport.html`);
    await expect(page.getByText("No open Threads", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add feedback", exact: true }).click();
    await page.getByRole("textbox", { name: "Review comment" }).fill("Retain this draft.");
    await page.getByRole("combobox", { name: "Feedback type" }).selectOption("thread");
    await page.getByRole("button", { name: "Save feedback", exact: true }).click();
    await readStarted.promise;
    await page.clock.fastForward(5_001);
    fixtureValue(gates[0], "gates[0]").resolve(saved);
    await expect(page.getByText("1 open Thread blocks Delivery", { exact: true })).toBeVisible();
  } finally {
    for (const gate of gates) gate.resolve(saved);
  }
});

test("Review publishes a newer command before an older read and never restores the old snapshot", async ({
  page,
}) => {
  const empty = visualReviewSchema.parse({
    recording: null,
    scenarios: [],
    feedback: [],
  });
  const saved = visualReviewSchema.parse({
    ...empty,
    feedback: [
      {
        id: "10000000-0000-4000-8000-000000000007",
        kind: "thread",
        state: "open",
        version: 1,
        authorId: "10000000-0000-4000-8000-000000000006",
        author: "You",
        commitSha: "a".repeat(40),
        annotation: null,
        createdAt: "2026-10-24T00:00:00.000Z",
        messages: [
          {
            id: "10000000-0000-4000-8000-000000000008",
            author: "You",
            body: "Do not restore the old snapshot.",
            createdAt: "2026-10-24T00:00:00.000Z",
          },
        ],
      },
    ],
  });
  const oldRead = Promise.withResolvers<typeof empty>(),
    started = Promise.withResolvers<void>();
  let reads = 0,
    created = false;
  await mockFactoryFunctions(page, {
    review: {
      async get() {
        if (++reads === 2) {
          started.resolve();
          return oldRead.promise;
        }
        return created ? saved : empty;
      },
      async create() {
        created = true;
        return { feedbackId: fixtureValue(saved.feedback[0], "saved.feedback[0]").id };
      },
    },
  });
  try {
    await page.goto(`${origin}/review-transport.html`);
    await expect(page.getByText("No open Threads", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reload review", exact: true }).click();
    await started.promise;
    await page.getByRole("button", { name: "Add feedback", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Review comment" })
      .fill("Do not restore the old snapshot.");
    await page.getByRole("combobox", { name: "Feedback type" }).selectOption("thread");
    await page.getByRole("button", { name: "Save feedback", exact: true }).click();
    await expect(page.getByText("1 open Thread blocks Delivery", { exact: true })).toBeVisible();
    const observed = page.waitForResponse(
      async (response) => await factoryFunctionMatches(response.url(), "getVisualReview"),
    );
    oldRead.resolve(empty);
    await observed;
    await expect(page.getByText("1 open Thread blocks Delivery", { exact: true })).toBeVisible();
  } finally {
    oldRead.resolve(empty);
  }
});
