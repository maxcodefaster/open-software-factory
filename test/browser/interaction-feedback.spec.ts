import { mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { feedbackAcknowledgementMs } from "../../apps/factory/src/ui/feedback-state";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import {
  attachmentInput,
  attachmentSummary,
  type AttachmentSummary,
} from "../../packages/conversation-domain/src/attachments";
import { CommandError } from "../../apps/factory/src/command-error";

const directory = ".factory/test-results/interaction-feedback";
const cacheDirectory = resolve(
  ".factory/test-results/vite",
  `interaction-feedback-${crypto.randomUUID()}`,
);
test.setTimeout(45_000);
let frontend: ViteDevServer;
let origin = "";
let errors: string[] = [];
const files = new Map<string, AttachmentSummary>();
let creates: string[] = [];
let uploads = 0;
let holdUpload: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let uploadReceived: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let loseUpload = false;
let messageLimit = 20 * 1024 * 1024;

test.beforeAll(async () => {
  const attachmentAPI = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const path = request.url?.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return next();
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const id = path.split("/")[3]!;
    if (request.method === "PUT" && files.has(id)) {
      uploads++;
      uploadReceived?.resolve();
      await holdUpload?.promise;
      const summary = attachmentSummary.parse({ ...files.get(id), state: "ready" });
      files.set(id, summary);
      if (loseUpload) {
        loseUpload = false;
        return json({ error: "Upload confirmation was lost. Retry the same file request." }, 503);
      }
      return json(summary);
    }
    if (request.method === "GET" && files.has(id)) return json(files.get(id));
    return json({ error: "Not part of this owned UI fixture." }, 404);
  };
  frontend = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cacheDirectory,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["interaction-feedback.html"] },
    plugins: [
      solid({
        ssr: false,
        serverFunctions: {
          devMiddleware: false,
          filter: { include: resolve("apps/factory/src/server-functions/**/*.{ts,tsx}") },
        },
      }),
      {
        name: "owned-feedback-uploads",
        configureServer(server) {
          server.middlewares.use(attachmentAPI);
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  await frontend.listen();
  origin = frontend.resolvedUrls!.local[0]!.replace(/\/$/, "");
  await mkdir(directory, { recursive: true });
});

test.afterAll(async () => {
  holdUpload?.resolve();
  await frontend?.close();
  await rm(cacheDirectory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  files.clear();
  creates = [];
  uploads = 0;
  holdUpload = undefined;
  uploadReceived = undefined;
  loseUpload = false;
  messageLimit = 20 * 1024 * 1024;
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockFactoryFunctions(page, {
    attachments: {
      async usage() {
        return {
          configured: true,
          usedBytes: 0,
          limits: { fileBytes: 10 * 1024 * 1024, messageBytes: messageLimit },
        };
      },
      async begin(_actor, raw) {
        const { id, name, bytes, mediaType, sha256 } = attachmentInput.parse(raw);
        creates.push(id);
        const summary =
          files.get(id) ??
          attachmentSummary.parse({
            id,
            name,
            bytes,
            mediaType,
            sha256,
            state: "uploading",
            failure: null,
            pages: 0,
          });
        files.set(id, summary);
        return summary;
      },
      async metadata(_actor, id) {
        const file = files.get(id);
        if (!file) throw new CommandError("not-found", "Owned file not found");
        return file;
      },
      async retainDraft() {
        return {};
      },
    },
  });
});

test.afterEach(async () => {
  holdUpload?.resolve();
  expect(errors).toEqual([]);
});

async function open(page: Page, surface: string) {
  await page.goto(`${origin}/interaction-feedback.html?surface=${surface}`);
  await expect(
    page.getByRole("heading", { name: "Factory interaction feedback", exact: true }),
  ).toBeVisible();
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    (await page.viewportSize())!.width,
  );
  const content = await page.locator(".feedback-proof").evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(content.scroll).toBeLessThanOrEqual(content.width);
}

test("copy feedback confirms actual clipboard content, preserves geometry and resets after reuse", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "copy");
  const reusable = page.getByRole("region", { name: "Reusable copy button" });
  const button = reusable.getByRole("button", { name: "Copy", exact: true });
  const before = await button.boundingBox();
  await button.focus();
  await button.press("Enter");
  await expect(button).toHaveAttribute("data-feedback", "success");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Factory reference");
  await expect(button).toBeFocused();
  expect((await button.boundingBox())!.width).toBe(before!.width);
  await capture(page, "copy-wide");
  await expect(button).toHaveAttribute("data-feedback", "idle", {
    timeout: feedbackAcknowledgementMs + 1_000,
  });
  await button.press("Space");
  await expect(button).toHaveAttribute("data-feedback", "success");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "copy-narrow");

  const reader = page.getByRole("region", { name: "Read-only code" });
  const codeButtons = reader.getByRole("button", { name: "Copy code", exact: true });
  await codeButtons.first().click();
  await expect(codeButtons.first()).toHaveAttribute("data-feedback", "success");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const ready = true;");
  await codeButtons.last().click();
  await expect(codeButtons.first()).toHaveAttribute("data-feedback", "idle");
  await expect(codeButtons.last()).toHaveAttribute("data-feedback", "success");

  const editor = page.getByRole("region", { name: "Editable code" });
  await editor.locator("pre").click();
  const editorCopy = editor.getByRole("button", { name: "Copy code", exact: true });
  await editorCopy.click();
  await expect(editorCopy).toHaveAttribute("data-feedback", "success");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const ready = true;");
});

async function controlledClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value: string) {
          const result = await fetch("/fixture/clipboard", { method: "POST", body: value });
          if (!result.ok) throw new Error("Controlled clipboard permission rejection");
        },
      },
    });
  });
}

test("clipboard rejection stays actionable and late clipboard results cannot cross context or unmount", async ({
  page,
}) => {
  await controlledClipboard(page);
  let calls = 0;
  let release = Promise.withResolvers<void>();
  let received = Promise.withResolvers<void>();
  let reject = true;
  await page.route("**/fixture/clipboard", async (route) => {
    calls++;
    received.resolve();
    if (!reject) await release.promise;
    await route.fulfill({ status: reject ? 403 : 200, body: "" });
  });
  await open(page, "copy");
  const button = page.getByRole("button", { name: "Copy", exact: true });
  try {
    await button.click();
    await expect(page.getByRole("alert")).toHaveText(
      "Could not copy. Select the text to copy manually.",
    );
    await expect(button).toHaveAttribute("data-feedback", "error");
    await capture(page, "copy-error");
    expect(calls).toBe(1);
    reject = false;
    received = Promise.withResolvers<void>();
    await button.click();
    await received.promise;
    await expect(button).toHaveAttribute("aria-busy", "true");
    await button.click();
    expect(calls).toBe(2);
    await page.getByRole("button", { name: "Switch copy context" }).click();
    await expect(button).toHaveAttribute("data-feedback", "idle");
    release.resolve();
    await page.waitForTimeout(100);
    await expect(button).toHaveAttribute("data-feedback", "idle");

    release = Promise.withResolvers<void>();
    received = Promise.withResolvers<void>();
    await button.click();
    await received.promise;
    await page.getByRole("button", { name: "Toggle copy controls" }).click();
    release.resolve();
    await page.getByRole("button", { name: "Toggle copy controls" }).click();
    await expect(button).toHaveAttribute("data-feedback", "idle");
  } finally {
    release.resolve();
  }
});

for (const surface of ["wiki", "ticket"] as const) {
  test(`${surface} save feedback waits for the acknowledgement, retains errors and fences navigation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let release = Promise.withResolvers<void>();
    let received = Promise.withResolvers<void>();
    let failure = false;
    let version = 1;
    await page.route(`**/fixture/${surface}-save`, async (route) => {
      const input = route.request().postDataJSON();
      received.resolve();
      await release.promise;
      await route.fulfill({
        status: failure ? 503 : 200,
        json: failure
          ? { error: "The save could not be confirmed. Your draft is retained." }
          : surface === "wiki"
            ? {
                id: input.id,
                version: ++version,
                title: input.title,
                body: input.body,
                revisionId: null,
              }
            : { id: crypto.randomUUID(), ticketVersion: ++version, requirementRevisionId: null },
      });
    });
    await open(page, surface);
    const status = page.locator(".save-feedback");
    const title =
      surface === "wiki"
        ? page.getByRole("textbox", { name: "Knowledge page title", exact: true })
        : page.getByRole("textbox", { name: "Ticket title", exact: true });
    try {
      if (surface === "wiki")
        await page.getByRole("button", { name: "Edit Knowledge title", exact: true }).click();
      await title.fill("Retain my updated reference");
      await expect(status).toHaveText("Changes will save automatically");
      await received.promise;
      await expect(status).toHaveText("Saving…");
      await expect(status).not.toHaveAttribute("data-feedback", "success");
      await capture(page, `${surface}-saving-wide`);
      release.resolve();
      await expect(status).toHaveText("Saved");
      await capture(page, `${surface}-saved-wide`);
      await expect(status).toHaveText("", { timeout: feedbackAcknowledgementMs + 1_000 });

      failure = true;
      await title.fill("Keep the failed draft");
      await expect(status).toHaveText("Not saved. Your draft is retained.");
      if (surface === "wiki") await expect(title).toHaveValue("Keep the failed draft");
      else await expect(title).toHaveText("Keep the failed draft");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, `${surface}-error-narrow`);

      release = Promise.withResolvers<void>();
      received = Promise.withResolvers<void>();
      failure = false;
      await title.fill("An older document's in-flight save");
      if (surface === "wiki") {
        // Wiki deliberately requires its explicit retry after a failed save.
        await page.getByRole("button", { name: "Retry", exact: true }).click();
      }
      await received.promise;
      if (surface === "wiki") {
        await page.getByRole("button", { name: "Browse Wiki pages", exact: true }).click();
        await page.getByRole("button", { name: "Second reference", exact: true }).click();
      } else await page.getByRole("button", { name: "Switch Ticket", exact: true }).click();
      release.resolve();
      await page.waitForTimeout(100);
      await expect(status).not.toHaveAttribute("data-feedback", "success");
    } finally {
      release.resolve();
    }
  });
}

test("file transfer completion stays distinct from readiness and retries retain the exact upload", async ({
  page,
}) => {
  holdUpload = Promise.withResolvers<void>();
  uploadReceived = Promise.withResolvers<void>();
  await open(page, "files");
  const name = "Product-reference-with-a-long-filename-and-a-clear-upload-state.txt";
  await page.getByLabel("Choose attachments").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("The actual uploaded reference."),
  });
  try {
    await uploadReceived.promise;
    const list = page.getByRole("list", { name: "File uploads", exact: true });
    await expect(list).toContainText("Preparing file…");
    await expect(page.getByRole("list", { name: "Prepared attachments" })).toHaveCount(0);
    expect(
      await list
        .locator(".feedback-mark")
        .evaluate((element) => getComputedStyle(element, "::before").animationName),
    ).toBe("feedback-working");
    await capture(page, "file-processing-wide");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await list
        .locator(".feedback-mark")
        .evaluate((element) => getComputedStyle(element, "::before").animationName),
    ).toBe("none");
    await capture(page, "file-processing-reduced-narrow");
    await page.getByRole("button", { name: "Switch file draft" }).click();
    holdUpload.resolve();
    await expect(list).toHaveCount(0);
    await page.getByRole("button", { name: "Switch file draft" }).click();
    const prepared = page.getByRole("list", { name: "Prepared attachments" });
    await expect(prepared).toContainText("Ready");
    await expect(
      prepared.getByRole("button", { name: `Attach prepared file ${name}` }),
    ).toBeVisible();
    await capture(page, "file-ready-narrow");

    loseUpload = true;
    await page.getByLabel("Choose attachments").setInputFiles({
      name: "Lost-confirmation.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Keep the same identity."),
    });
    await page.getByRole("button", { name: "Retry file upload", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry file upload", exact: true })).toHaveCount(
      0,
    );
    await expect.poll(() => creates.length).toBe(3);
    await expect(
      prepared
        .locator("li")
        .filter({ hasText: "Lost-confirmation.txt" })
        .locator('[data-feedback="success"]'),
    ).toHaveText("Ready");
    expect(creates[1]).toBe(creates[2]);
    expect(uploads).toBe(2);
  } finally {
    holdUpload.resolve();
  }
});

test("message size rejection names the file and keeps prose and earlier attachments", async ({
  page,
}) => {
  messageLimit = 20;
  await open(page, "files");
  const input = page.getByRole("textbox", { name: "Message with references", exact: true });
  await input.fill("Keep my explanation.");
  await page.getByLabel("Choose attachments").setInputFiles([
    { name: "First.txt", mimeType: "text/plain", buffer: Buffer.alloc(8, "a") },
    { name: "Second.txt", mimeType: "text/plain", buffer: Buffer.alloc(8, "b") },
  ]);
  const prepared = page.getByRole("list", { name: "Prepared attachments" });
  await expect(prepared.locator("li")).toHaveCount(2);
  await expect(page.locator(".attachment-count")).toContainText("16 B / 20 B");
  await expect(input).toHaveValue("Keep my explanation.");
  await page.getByLabel("Choose attachments").setInputFiles({
    name: "Third.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(8, "c"),
  });
  await expect(page.getByRole("alert")).toContainText("Third.txt was not attached");
  await expect(page.getByRole("alert")).toContainText("per message");
  await expect(prepared.locator("li")).toHaveCount(2);
  await expect(input).toHaveValue("Keep my explanation.");
  expect(creates).toHaveLength(2);
});

test("an unsupported file does not prevent the next selected file from attaching", async ({
  page,
}) => {
  await open(page, "files");
  await page.getByLabel("Choose attachments").setInputFiles([
    { name: "Archive.zip", mimeType: "application/zip", buffer: Buffer.from("Not supported") },
    { name: "Reference.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this reference") },
  ]);
  await expect(page.getByRole("alert")).toContainText("Archive.zip was not attached");
  await expect(
    page.getByRole("link", { name: "Download Reference.txt", exact: true }),
  ).toBeVisible();
  expect(creates).toHaveLength(1);
});

test("a failed send re-enables the same textarea without losing prose or file references", async ({
  page,
}) => {
  await page.route("**/fixture/message", (route) =>
    route.fulfill({ status: 503, body: "Send unconfirmed." }),
  );
  await open(page, "files");
  const input = page.getByRole("textbox", { name: "Message with references", exact: true });
  await input.fill("Keep this explanation and its file.");
  await input.evaluate((element) => element.setAttribute("data-original-textarea", "true"));
  await page.getByLabel("Choose attachments").setInputFiles({
    name: "Reference.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("The reference"),
  });
  const list = page.getByRole("list", { name: "Prepared attachments" });
  await expect(list.locator("li")).toHaveCount(1);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Send unconfirmed. Your draft is retained.");
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute("data-original-textarea", "true");
    await expect(input).toHaveValue("Keep this explanation and its file.");
    await expect(list.locator("li")).toHaveCount(1);
  }
});

test("slash Skill insertion preserves already prepared file references", async ({ page }) => {
  await mockFactoryFunctions(page, {
    skills: {
      async invocations() {
        return {
          skills: [
            {
              id: "10000000-0000-4000-8000-000000000008",
              key: "review-reference",
              name: "Review the reference",
              description: "Inspect the supplied reference.",
            },
          ],
          conflicts: [],
        };
      },
    },
  });
  let submitted = "";
  await page.route("**/fixture/message", async (route) => {
    submitted = route.request().postData() ?? "";
    await route.fulfill({ status: 503, body: "Send unconfirmed." });
  });
  await open(page, "files");
  await page.getByLabel("Choose attachments").setInputFiles({
    name: "Reference.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("The retained reference."),
  });
  const file = page.getByRole("link", { name: "Download Reference.txt", exact: true });
  await expect(file).toBeVisible();
  const reference = (await file.getAttribute("href"))!;
  const draft = page.getByRole("textbox", { name: "Message with references", exact: true });
  await draft.fill("Please /rev");
  await expect(page.getByRole("option", { name: /Review the reference/ })).toBeVisible();
  await draft.press("Enter");
  await expect(draft).toHaveValue("Please /review-reference ");
  await expect(file).toHaveAttribute("href", reference);
  await expect(page.getByRole("list", { name: "Prepared attachments" }).locator("li")).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => submitted).toContain(reference);
  expect(submitted).toContain("/review-reference");
  await expect(draft).toHaveValue("Please /review-reference ");
});

test("narrow feedback keeps the complete size limit and hides desktop attachment arrows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "files&attachments=feedback");
  await page.getByLabel("Choose attachments").setInputFiles(
    Array.from({ length: 5 }, (_, index) => ({
      name: `Feedback-reference-${index + 1}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`Reference ${index + 1}\n`.repeat(12_000)),
    })),
  );
  const list = page.getByRole("list", { name: "Prepared attachments" });
  await expect(list.locator("li")).toHaveCount(5);
  const count = page.locator(".attachment-count");
  await expect(count).toHaveText("5 files · 0.7 / 20 MiB");
  expect(await count.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Scroll attachments right" })).not.toBeVisible();
  await expect(page.locator(".attachment-privacy")).toHaveCount(0);
  const help = page.getByLabel("Attachment formats and limits", { exact: true });
  await help.click();
  await expect(page.locator(".attachment-help-content")).toContainText(
    "New files stay private until this feedback is saved.",
  );
  await help.press("Escape");
  await page.locator("form").screenshot({ path: `${directory}/five-feedback-files-narrow.png` });
});

test("five attachments stay in one row above the input and remain accessible when scrolled", async ({
  page,
}) => {
  await open(page, "files");
  const picker = page.getByLabel("Choose attachments");
  const input = page.getByRole("textbox", { name: "Message with references", exact: true });
  await input.fill("Keep the draft while browsing attachments.");
  const files = Array.from({ length: 5 }, (_, index) => ({
    name: `Product-reference-${index + 1}-with-a-long-filename.${index ? "txt" : "markdown"}`,
    mimeType: index ? "text/plain" : "text/markdown",
    buffer: Buffer.from(`Reference ${index + 1}\n`.repeat(12_000)),
  }));
  await picker.setInputFiles(files[0]!);
  const list = page.getByRole("list", { name: "Prepared attachments", exact: true });
  await expect(list.locator("li")).toHaveCount(1);
  const firstHeight = (await list.boundingBox())!.height;
  await picker.setInputFiles(files.slice(1));
  await expect(list.locator("li")).toHaveCount(5);
  await expect(page.locator(".attachment-count")).toContainText("5 files");
  expect((await list.boundingBox())!.height).toBeLessThanOrEqual(firstHeight + 2);
  await page.getByRole("button", { name: "Scroll attachments right", exact: true }).click();
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await list.focus();
  await list.press("Home");
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBe(0);
  await page.locator("form").screenshot({ path: `${directory}/five-files-composer-wide.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".attachment-count")).toHaveText("5 files · 0.7 / 20 MiB");
  expect(
    await page
      .locator(".attachment-count")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const top = await list
    .locator("li")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  expect(Math.max(...top) - Math.min(...top)).toBeLessThan(1);
  expect((await list.boundingBox())!.y + (await list.boundingBox())!.height).toBeLessThanOrEqual(
    (await input.boundingBox())!.y,
  );
  await capture(page, "five-files-narrow");
  const attach = page.getByRole("button", { name: "Add image or file", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const attachBox = (await attach.boundingBox())!;
  const sendBox = (await send.boundingBox())!;
  expect(
    Math.abs(attachBox.y + attachBox.height / 2 - sendBox.y - sendBox.height / 2),
  ).toBeLessThan(1);
  expect(attachBox.x).toBeLessThan(sendBox.x);
  const attachIcon = (await attach.locator("svg").boundingBox())!;
  const sendIcon = (await send.locator("svg").boundingBox())!;
  expect(attachIcon.width).toBeLessThan(sendIcon.width);
  const metadataOverlap = await list.locator("li").evaluateAll((items) =>
    items.map((item) => {
      const ready = item.querySelector(".attachment-file-ready")!.getBoundingClientRect();
      const remove = item.querySelector(".attachment-file-remove")!.getBoundingClientRect();
      return ready.right - remove.left;
    }),
  );
  expect(Math.max(...metadataOverlap)).toBeLessThanOrEqual(0);
  const shell = (await page.locator("form").boundingBox())!;
  const topPadding = (await list.locator("li").first().boundingBox())!.y - shell.y;
  const bottomPadding = shell.y + shell.height - sendBox.y - sendBox.height;
  expect(Math.abs(topPadding - bottomPadding)).toBeLessThanOrEqual(4);
  await page.locator("form").screenshot({ path: `${directory}/five-files-composer-narrow.png` });
  const lastLink = list.getByRole("link", { name: `Download ${files[4]!.name}`, exact: true });
  await lastLink.focus();
  await expect(lastLink).toBeFocused();
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const remove = list.getByRole("button", {
    name: `Remove attachment ${files[4]!.name}`,
    exact: true,
  });
  const target = await remove.boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(44);
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await remove.press("Enter");
  await expect(list.locator("li")).toHaveCount(4);
  await expect(input).toHaveValue("Keep the draft while browsing attachments.");
  const help = page.getByLabel("Attachment formats and limits", { exact: true });
  await help.focus();
  await help.press("Enter");
  await expect(page.locator(".attachment-restrictions")).toBeVisible();
  await expect(page.locator(".attachment-restrictions")).toContainText("DOCX");
  const panel = page.locator(".attachment-help-content");
  await expect(panel).toBeInViewport();
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await capture(page, "five-files-help-narrow");
  await help.press("Escape");
  await expect(help).toBeFocused();
  await expect(page.locator(".attachment-restrictions")).not.toBeVisible();
});
