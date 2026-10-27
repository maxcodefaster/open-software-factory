import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { expect as browserExpect, chromium } from "@playwright/test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createAttachmentRoutes } from "../../apps/factory/src/attachments/routes";
import { createAttachmentStore } from "../../apps/factory/src/attachments/store";
import { CommandError } from "../../apps/factory/src/command-error";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import { createReviewService } from "../../apps/factory/src/review/service";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { attachmentIDs } from "../../packages/conversation-domain/src/attachments";
import { ownedAttachmentS3 } from "../fixtures/attachment-s3";
import { fixture } from "../fixtures/change-agent-turns";
import { callFactoryFunction, compiledFactoryEndpoint } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";
import { productionBuildEnvironment } from "../../scripts/testing/test-prerequisites";

// Bun does not load playwright.config.ts. Match the ordinary browser lane's
// observation window, including real conversion and storage acknowledgement.
const visible = browserExpect.configure({ timeout: 30_000 });

test("Wiki, private drafts, personal/Ticket chat and feedback replies upload through native S3 without starting agents", async () => {
  const f = await fixture();
  const pageID = crypto.randomUUID(),
    draftID = crypto.randomUUID(),
    otherID = crypto.randomUUID();
  let s3: Awaited<ReturnType<typeof ownedAttachmentS3>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let loseNextUpload = false;
  let functions: Awaited<ReturnType<typeof compiledFactoryEndpoint>>;
  let holdNextUpload = false;
  const uploadStarted = Promise.withResolvers<void>();
  const releaseUpload = Promise.withResolvers<void>();
  const pendingUploads = new Set<Promise<Response | undefined>>();
  try {
    const parentOwner = process.env["FACTORY_ATTACHMENT_S3_PROOF_OWNER"];
    // A prestarted proof service belongs to the outer runner. It cleans that
    // exact container after this test's DB/stream teardown, outside Bun's timer.
    s3 = await ownedAttachmentS3(parentOwner, Boolean(parentOwner));
    const store = createAttachmentStore(f.database);
    const routes = createAttachmentRoutes(store);
    const forgeEnvironment = [
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_FORGEJO_TOKEN",
      "FACTORY_FORGEJO_OWNER",
    ];
    const savedForge = forgeEnvironment.map((key) => process.env[key]);
    process.env["FACTORY_FORGEJO_API_URL"] ??= "http://127.0.0.1:9/api/v1";
    process.env["FACTORY_FORGEJO_TOKEN"] ??= "owned-fixture-not-a-secret";
    process.env["FACTORY_FORGEJO_OWNER"] ??= "owned-fixture";
    const knowledge = createKnowledgeController(f.database);
    forgeEnvironment.forEach((key, index) => {
      if (savedForge[index] === undefined) delete process.env[key];
      else process.env[key] = savedForge[index];
    });
    const review = createVisualReviewController(f.database);
    const directory = resolve(".factory/test-results/attachments-browser", f.projectID);
    const buildDirectory = resolve(directory, "frontend");
    const frontend = resolve(buildDirectory, "client");
    const personalConversation = crypto.randomUUID(),
      ticketConversation = crypto.randomUUID();
    await mkdir(directory, { recursive: true });
    await f.database
      .client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${otherID},'Other Project member',${`${otherID}@factory.local`},true)`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${f.projectID},${otherID},'product-contributor',${f.userID})`;
    await f.database
      .client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
    VALUES(${pageID},${f.projectID},${`attachment-${pageID}`},'Reference','## Reference','## Reference',${"a".repeat(40)},${f.userID})`;
    for (const [id, ticket, mode] of [
      [personalConversation, null, "investigate"],
      [ticketConversation, f.ticketID, "build"],
    ] as const)
      await f.database
        .client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by) VALUES(${id},${f.projectID},${ticket},${mode},${f.userID})`;
    const build = Bun.spawn(
      [
        "node",
        resolve("node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        resolve("test/fixtures/attachments-vite.config.ts"),
        "--outDir",
        buildDirectory,
      ],
      { env: productionBuildEnvironment(process.env), stdout: "ignore", stderr: "pipe" },
    );
    const errors = await new Response(build.stderr).text();
    if (await build.exited) throw new Error(errors);
    if (!(await Bun.file(resolve(frontend, "attachments.html")).exists()))
      throw new Error("Owned attachment UI build did not emit its component entry");
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 180,
      async fetch(request) {
        const url = new URL(request.url);
        const user = request.headers.get("x-fixture-user") === otherID ? otherID : f.userID;
        try {
          if (url.pathname.startsWith("/_server/")) return functions(request);
          if (url.pathname.startsWith("/api/attachments/")) {
            const pending = routes(request, user);
            if (request.method === "PUT") pendingUploads.add(pending);
            let result: Response;
            try {
              result = (await pending) ?? new Response(null, { status: 404 });
            } finally {
              pendingUploads.delete(pending);
            }
            if (holdNextUpload && request.method === "PUT" && result.ok) {
              holdNextUpload = false;
              uploadStarted.resolve();
              await releaseUpload.promise;
            }
            if (
              loseNextUpload &&
              request.method === "PUT" &&
              url.pathname.startsWith("/api/attachments/") &&
              result.ok
            ) {
              loseNextUpload = false;
              return Response.json(
                { error: "Upload confirmation was lost. Retry the same file request." },
                { status: 503 },
              );
            }
            return result;
          }
          if (url.pathname === "/fixture/lose-upload" && request.method === "POST") {
            loseNextUpload = true;
            return Response.json({});
          }
          if (url.pathname === "/fixture/wiki") {
            if (request.method === "GET") {
              const [page] = await f.database
                .client`SELECT current_body AS body,version::integer AS version FROM factory.knowledge_page WHERE id=${pageID}`;
              return Response.json(page);
            }
            return Response.json(
              await knowledge.edit(
                pageID,
                { ...(await request.json()), title: "Reference" },
                f.userID,
              ),
            );
          }
          if (url.pathname === "/fixture/ticket") {
            const draft = await request.json();
            await f.database
              .client`INSERT INTO factory.ticket(id,project_id,title,description,created_by)
            VALUES(${draft.id},${f.projectID},${draft.title},${draft.description},${f.userID})`;
            return Response.json({});
          }
          if (url.pathname === "/fixture/chat") {
            const input = await request.json();
            await f.database.client.begin((sql) =>
              appendConversationEntry(
                sql,
                input.ticket ? ticketConversation : personalConversation,
                {
                  kind: "user-message",
                  actor: "user",
                  mode: input.ticket ? "build" : "investigate",
                  body: input.body,
                  payload: {},
                  citations: [],
                  inReplyToEntryId: null,
                  requirementRevisionId: null,
                  createdBy: f.userID,
                },
              ),
            );
            return Response.json({});
          }
          const path = resolve(
            frontend,
            url.pathname === "/" ? "attachments.html" : `.${url.pathname}`,
          );
          return path.startsWith(frontend + sep)
            ? new Response(Bun.file(path))
            : new Response(null, { status: 404 });
        } catch (cause) {
          return Response.json(
            { error: cause instanceof Error ? cause.message : "Fixture failure" },
            { status: cause instanceof CommandError ? cause.status : 500 },
          );
        }
      },
    });
    functions = await compiledFactoryEndpoint(
      {
        origin: server.url.origin,
        services: {
          attachments: store,
          review: createReviewService({
            controller: review,
            access: createAccessController(f.database),
            admit: async () => {
              throw new Error("Attachment proof does not commission Coding");
            },
            dispatchPending: async () => {},
          }),
        } as unknown as FactoryServices,
        session: async (request) => ({
          user: {
            id: request.headers.get("x-fixture-user") === otherID ? otherID : f.userID,
          },
        }),
        maintenance: async () => false,
        requireFresh: async () => {},
      },
      resolve(buildDirectory, "server/start-server.js"),
    );
    browser = await chromium.launch(
      process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
        ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
        : {},
    );
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const captureNarrow = async (name: string) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: resolve(directory, `${name}-mobile.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.setViewportSize({ width: 1280, height: 900 });
    };
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(
      `${server.url}?project=${f.projectID}&change=${f.changeID}&user=${f.userID}&draft=${draftID}`,
    );
    const canvas = createCanvas(180, 90);
    const context = canvas.getContext("2d");
    context.fillStyle = "#246b4a";
    context.fillRect(0, 0, 180, 90);
    const image = {
      name: "design.png",
      mimeType: "image/png",
      buffer: Buffer.from(await canvas.encode("png")),
    };
    const textFile = {
      name: "requirements.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Confirmation code 7319"),
    };
    const wiki = page.getByRole("region", { name: "Wiki attachment editor" });
    const editor = wiki.getByRole("textbox", { name: "Knowledge body" });
    await visible(editor).toBeVisible();
    await visible(wiki.getByRole("button", { name: "Add image or file", exact: true })).toHaveCount(
      0,
    );
    expect(
      await wiki
        .locator(".attachment-insert-compact")
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBe(0);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\n/image");
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Image", exact: true }).click();
    await (await choosing).setFiles(image);
    await visible(wiki.locator("img.document-attachment-image")).toBeVisible();
    const imageLink = wiki.getByRole("link", {
      name: "Open image design.png in new tab",
      exact: true,
    });
    await imageLink.focus();
    const opening = page.context().waitForEvent("page");
    await imageLink.press("Enter");
    const original = await opening;
    await original.waitForLoadState("load");
    await visible(original.locator("img")).toBeVisible();
    expect(
      await original.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth),
    ).toBe(180);
    await original.close();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\n/file");
    await visible(page.getByRole("menuitem", { name: "File", exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve(directory, "wiki-file-slash-desktop.png"),
      animations: "disabled",
    });
    const choosingDocument = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await choosingDocument).setFiles(textFile);
    await visible(editor.getByRole("link", { name: /^requirements\.txt/ })).toBeVisible();
    await visible(wiki.getByRole("button", { name: "Add image or file", exact: true })).toHaveCount(
      0,
    );
    await wiki.getByRole("button", { name: "Save Wiki", exact: true }).click();
    await visible(
      page
        .getByRole("article", { name: "Saved Wiki" })
        .getByRole("link", { name: "requirements.txt" }),
    ).toContainText("requirements.txt");
    await page.screenshot({ path: resolve(directory, "wiki-desktop.png"), fullPage: true });
    await captureNarrow("wiki");
    await page.reload();
    await visible(page.locator("img.document-attachment-image")).toBeVisible();

    await page.getByRole("button", { name: "Ticket draft", exact: true }).click();
    await page.getByRole("textbox", { name: "Ticket title" }).fill("Attachment draft");
    const draftEditor = page.getByRole("textbox", { name: "Ticket description", exact: true });
    await visible(draftEditor).toBeVisible();
    await visible(page.locator(".rich-editor-host .attachment-add")).toHaveCount(0);
    await draftEditor.fill("Use the pasted references.");
    expect(
      await draftEditor.evaluate(
        (element, payloads) => {
          const clipboard = new DataTransfer();
          for (const payload of payloads)
            clipboard.items.add(
              new File(
                [Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0))],
                payload.name,
                { type: payload.mimeType },
              ),
            );
          return !element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboard,
            }),
          );
        },
        [image, textFile].map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          base64: file.buffer.toString("base64"),
        })),
      ),
    ).toBe(true);
    await visible(page.locator("img.document-attachment-image")).toBeVisible();
    await visible(draftEditor.getByRole("link", { name: /^requirements\.txt/ })).toBeVisible();
    await visible(draftEditor).toContainText("Use the pasted references.");
    await visible(page.locator(".rich-editor-host .attachment-add")).toHaveCount(0);
    const draftBody = await page.getByRole("textbox", { name: "Ticket description" }).textContent();
    const [draftAsset] = await f.database.client<
      { id: string }[]
    >`SELECT id FROM factory.attachment WHERE draft_id=${draftID}`;
    expect(draftAsset).toBeDefined();
    await page.screenshot({ path: resolve(directory, "draft-desktop.png"), fullPage: true });
    await captureNarrow("draft");
    expect(
      await callFactoryFunction(
        server.url.origin,
        "getAttachmentMetadata",
        [fixtureValue(draftAsset, "draftAsset").id],
        {
          "x-fixture-user": otherID,
        },
      ),
    ).toMatchObject({ ok: false, status: 404 });
    await page.getByRole("button", { name: "Create as idea" }).click();
    await visible(page.getByRole("status").filter({ hasText: "Created Ticket" })).toBeVisible();
    expect(
      await callFactoryFunction(
        server.url.origin,
        "getAttachmentMetadata",
        [fixtureValue(draftAsset, "draftAsset").id],
        {
          "x-fixture-user": otherID,
        },
      ),
    ).toMatchObject({ ok: true });
    expect(draftBody).not.toContain("/image");

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Chat message" }).fill("Private design reference.");
    const [beforeUpload] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM factory.attachment WHERE project_id=${f.projectID}`;
    await page.request.post(`${server.url}fixture/lose-upload`);
    await page.getByLabel("Choose attachments").setInputFiles(image);
    await visible(
      page.getByRole("button", { name: "Retry file upload", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(directory, "chat-unconfirmed-desktop.png"),
      fullPage: true,
    });
    await captureNarrow("chat-unconfirmed");
    await page.getByRole("button", { name: "Wiki", exact: true }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await visible(
      page.getByRole("button", { name: "Retry file upload", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry file upload", exact: true }).click();
    await visible(page.getByRole("status")).toContainText("design.png is ready");
    const [afterUpload] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM factory.attachment WHERE project_id=${f.projectID}`;
    expect(afterUpload?.count).toBe((beforeUpload?.count ?? 0) + 1);
    await page.getByRole("textbox", { name: "Chat message" }).evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["Drop reference"], "dropped.txt", { type: "text/plain" }));
      element.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await visible(page.getByText("Drop files to attach", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Chat message" }).evaluate((element, data) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], "dropped.txt", { type: "text/plain" }));
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    }, "Drop context 7319");
    await visible(page.getByRole("status")).toContainText("dropped.txt is ready");
    await visible(page.getByText("Drop files to attach", { exact: true })).toHaveCount(0);
    const authored = await page.getByRole("textbox", { name: "Chat message" }).inputValue();
    expect(authored).toBe("Private design reference.");
    await page
      .getByRole("textbox", { name: "Chat message" })
      .fill("Editing the prose keeps the file references.");
    await visible(
      page.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(2);
    await page.getByRole("button", { name: "Remove attachment dropped.txt", exact: true }).click();
    await visible(
      page.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(1);
    await visible(page.getByRole("textbox", { name: "Chat message" })).toHaveValue(
      "Editing the prose keeps the file references.",
    );
    await page.getByRole("textbox", { name: "Chat message" }).fill(authored);
    await page.getByLabel("Share in Ticket chat").check();
    await visible(page.getByRole("textbox", { name: "Chat message" })).toHaveValue("");
    await visible(page.getByRole("list", { name: "Prepared attachments" })).toHaveCount(0);
    await page.getByLabel("Share in Ticket chat").uncheck();
    await visible(page.getByRole("textbox", { name: "Chat message" })).toHaveValue(authored);
    await visible(
      page.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(1);
    holdNextUpload = true;
    await page.getByLabel("Choose attachments").setInputFiles({
      ...textFile,
      name: "retained.txt",
    });
    await uploadStarted.promise;
    await page.getByRole("button", { name: "Wiki", exact: true }).click();
    releaseUpload.resolve();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const prepared = page.getByRole("button", { name: "Attach prepared file retained.txt" });
    await visible(prepared).toBeVisible();
    await prepared.focus();
    await prepared.press("Enter");
    await visible(page.getByRole("textbox", { name: "Chat message" })).toHaveValue(authored);
    await visible(
      page.getByRole("link", { name: "Download retained.txt", exact: true }),
    ).toBeVisible();
    await visible(page.locator(".attachment-privacy")).toHaveCount(0);
    await page.screenshot({ path: resolve(directory, "chat-ready-desktop.png"), fullPage: true });
    await captureNarrow("chat-ready");
    const privateID = fixtureValue(
      attachmentIDs(
        (await page
          .getByRole("link", { name: "Open image design.png", exact: true })
          .getAttribute("href")) ?? "",
      )[0],
      'attachmentIDs( (await page .getByRole("link", { name: "Open image design.png", exact: true }) .getAttribute("href")) ?? ',
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await visible(page.getByRole("textbox", { name: "Chat message" })).toHaveValue("");
    await visible(page.getByRole("list", { name: "Prepared attachments" })).toHaveCount(0);
    expect(
      await callFactoryFunction(server.url.origin, "getAttachmentMetadata", [privateID], {
        "x-fixture-user": otherID,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    await page.getByLabel("Share in Ticket chat").check();
    await page
      .getByRole("textbox", { name: "Chat message" })
      .fill("Use this reference for the Ticket.");
    await page.getByRole("textbox", { name: "Chat message" }).evaluate((element, encoded) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0))], "pasted.png", {
          type: "image/png",
        }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    }, image.buffer.toString("base64"));
    await visible(page.getByRole("status")).toContainText("pasted.png is ready");
    await visible(page.getByRole("textbox", { name: "Chat message" })).toHaveValue(
      "Use this reference for the Ticket.",
    );
    const ticketID = fixtureValue(
      attachmentIDs(
        (await page
          .getByRole("link", { name: "Open image pasted.png", exact: true })
          .getAttribute("href")) ?? "",
      )[0],
      'attachmentIDs( (await page .getByRole("link", { name: "Open image pasted.png", exact: true }) .getAttribute("href")) ?? ',
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await visible(page.getByRole("textbox", { name: "Chat message" })).toHaveValue("");
    expect(
      await callFactoryFunction(server.url.origin, "getAttachmentMetadata", [ticketID], {
        "x-fixture-user": otherID,
      }),
    ).toMatchObject({ ok: true });

    await page.getByRole("button", { name: "Interview", exact: true }).click();
    const interview = page.getByRole("region", { name: "Interview attachments" });
    await interview.getByRole("textbox", { name: "Custom answer" }).fill("Follow this reference.");
    await interview.getByLabel("Choose attachments").setInputFiles(textFile);
    await visible(
      interview.getByRole("status").filter({ hasText: "requirements.txt is ready" }),
    ).toBeVisible();
    await visible(interview.getByRole("textbox", { name: "Custom answer" })).toHaveValue(
      "Follow this reference.",
    );
    const interviewID = fixtureValue(
      attachmentIDs(
        (await interview
          .getByRole("link", { name: "Download requirements.txt", exact: true })
          .getAttribute("href")) ?? "",
      )[0],
      'attachmentIDs( (await interview .getByRole("link", { name: "Download requirements.txt", exact: true }) .getAttribute("hr',
    );
    await page.screenshot({ path: resolve(directory, "interview-desktop.png"), fullPage: true });
    await captureNarrow("interview");
    await page.reload();
    await page.getByRole("button", { name: "Interview", exact: true }).click();
    await visible(interview.getByRole("textbox", { name: "Custom answer" })).toHaveValue(
      "Follow this reference.",
    );
    await visible(
      interview.getByRole("link", { name: "Download requirements.txt", exact: true }),
    ).toBeVisible();
    expect(
      await callFactoryFunction(server.url.origin, "getAttachmentMetadata", [interviewID], {
        "x-fixture-user": otherID,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    await interview.getByRole("button", { name: "Continue", exact: true }).click();
    await visible(interview.locator(".answered-question")).toBeVisible();
    expect(
      await callFactoryFunction(server.url.origin, "getAttachmentMetadata", [interviewID], {
        "x-fixture-user": otherID,
      }),
    ).toMatchObject({ ok: true });

    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByRole("button", { name: "New feedback", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Review comment" })
      .fill("Follow the attached visual reference.");
    await page.getByLabel("Feedback type").selectOption("thread");
    await page.getByLabel("Choose attachments").setInputFiles(image);
    await visible(
      page.getByRole("status").filter({ hasText: "design.png is ready" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Wiki", exact: true }).click();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await visible(page.getByRole("textbox", { name: "Review comment" })).toHaveValue(
      "Follow the attached visual reference.",
    );
    await visible(
      page.getByRole("link", { name: "Open image design.png", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible(page.locator(".review-message-body img")).toBeVisible();
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: /Reply to/ }).fill("The supporting document.");
    await page.getByLabel("Choose attachments").setInputFiles(textFile);
    await visible(
      page.getByRole("status").filter({ hasText: "requirements.txt is ready" }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: /Reply to/ }).fill("");
    await visible(page.getByRole("button", { name: "Add reply", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Add reply", exact: true }).click();
    await visible(page.locator(".review-message-body a.factory-attachment-file")).toContainText(
      "requirements.txt",
    );
    await page.screenshot({ path: resolve(directory, "feedback-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(directory, "feedback-mobile.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const [turns] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM factory.agent_turn WHERE project_id=${f.projectID}`;
    expect(turns?.count).toBe(0);
    expect(pageErrors).toEqual([]);
    console.log(`Inspected attachment UI evidence: ${directory}`);
  } catch (cause) {
    console.error("Owned attachment browser proof failed", cause);
    throw cause;
  } finally {
    releaseUpload.resolve();
    await browser?.close();
    // A detached browser does not cancel admitted processing. Keep its owned
    // database and bucket until that exact work has settled.
    await Promise.allSettled([...pendingUploads]);
    await server?.stop(true);
    await s3?.dispose();
    await f.database.client.begin(async (sql) => {
      await sql`SET LOCAL session_replication_role=replica`;
      await sql`DELETE FROM factory.knowledge_revision WHERE page_id=${pageID}`;
      await sql`DELETE FROM factory.knowledge_page WHERE id=${pageID} AND project_id=${f.projectID}`;
      await sql`DELETE FROM factory.ticket WHERE id=${draftID} AND project_id=${f.projectID}`;
    });
    await f.dispose();
  }
}, 180_000);
