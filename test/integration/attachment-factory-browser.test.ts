import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect as browserExpect, chromium } from "@playwright/test";
import { attachmentIDs } from "../../packages/conversation-domain/src/attachments";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { attachmentDOCX, attachmentPDF } from "../fixtures/attachment-files";
import { ownedAttachmentS3 } from "../fixtures/attachment-s3";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { factoryProcess } from "../fixtures/factory-process";
import { openProjectMenu } from "../fixtures/project-menu";

const visible = browserExpect.configure({ timeout: 30_000 });

// Full Factory, authentication, Zero, document/review commands and private S3.
// A failed-send transport probe records the actual composer payload without
// commissioning a model or Sandbox. The optional review pause exposes
// only its owned loopback installation until the exact stop marker is written.
test("chat controls, Project switching and attachments fit Factory at desktop and phone sizes", async () => {
  const s3 = await ownedAttachmentS3();
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") return new Response(null, { status: 403 });
      if (path === "/api/v1/repos/owned-process-fixture/attachments")
        return Response.json({
          owner: { login: "owned-process-fixture" },
          name: "attachments",
          default_branch: "main",
        });
      if (path === "/api/v1/repos/owned-process-fixture/attachments/branches/main")
        return Response.json({ name: "main", commit: { id: "a".repeat(40) } });
      if (path.includes("/git/trees/")) return Response.json({ tree: [], truncated: false });
      return new Response(null, { status: 404 });
    },
  });
  const owned = await factoryProcess(undefined, {
    FACTORY_FORGEJO_API_URL: `${forge.url}api/v1/`,
  }).catch(async (cause) => {
    await s3.dispose();
    await forge.stop(true);
    throw cause;
  });
  const directory = resolve(".factory/test-results/attachment-ux", owned.id);
  await mkdir(directory, { recursive: true });
  const database = owned.connect();
  const browser = await chromium.launch({ headless: true });
  let f: Awaited<ReturnType<typeof candidateReviewFixture>> | undefined;
  let page: import("@playwright/test").Page | undefined;
  let completed = false;
  const errors: string[] = [];
  const failedReads: { path: string; status: number }[] = [];
  try {
    await owned.startPlanningCache();
    await owned.start();
    f = await candidateReviewFixture(
      canonicalRequirementContent({
        summary: "Explain saved feedback without losing the author's references.",
        acceptanceCriteria: [
          "An image and supporting document remain readable with the saved discussion.",
          "Unsent references stay in the original draft when navigating.",
        ],
        nonGoals: ["Start implementation while attaching a file."],
      }),
      database,
    );
    const fixture = f;
    const otherProjectID = crypto.randomUUID();
    const otherSlug = `other-${owned.id.slice(0, 8)}`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      SELECT ${otherProjectID},${otherSlug},'Other Product',repository_url,default_branch,devcontainer_path,created_by
      FROM factory.project WHERE id=${f.projectID}`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${otherProjectID},${f.userID},'developer',${f.userID})`;
    await database.client`UPDATE auth."user" SET name='Mara Fischer' WHERE id=${f.userID}`;
    await database.client`UPDATE factory.project SET name='Attachment UX' WHERE id=${f.projectID}`;
    await database.client`UPDATE factory.project SET repository_url=${`${forge.url}owned-process-fixture/attachments.git`}
      WHERE id=${f.projectID}`;
    await database.client`UPDATE factory.ticket SET title='Keep references with saved feedback',state='ready' WHERE id=${f.ticketID}`;
    await database.client`INSERT INTO factory.branch_create_operation(
      id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','attachments',branch_name,base_sha,${`owned-attachment-ux:${owned.id}`},'succeeded',base_sha,now()
      FROM factory.change WHERE id=${f.changeID}`;
    const pageID = crypto.randomUUID();
    await database.client`INSERT INTO factory.knowledge_page(
      id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${pageID},${f.projectID},'reference-material','Reference material',
        '## Feedback references\n\nKeep the visual reference and supporting document together.',
        '## Feedback references',${"a".repeat(40)},${f.userID})`;
    await database.client`INSERT INTO factory.knowledge_generation(
      id,project_id,source_commit_sha,state,page_count,conflict_count,created_by,completed_at)
      VALUES(${crypto.randomUUID()},${f.projectID},${"a".repeat(40)},'succeeded',1,0,${f.userID},now())`;
    await database.client`INSERT INTO auth.account(id,account_id,provider_id,user_id,password)
      SELECT ${crypto.randomUUID()},${f.userID},'credential',${f.userID},password
      FROM auth.account WHERE user_id='01994a7d-0000-7000-8000-000000000001' AND provider_id='credential'`;
    const [user] = await database.client<{ email: string }[]>`
      SELECT email FROM auth."user" WHERE id=${f.userID}`;
    if (!user) throw new Error("Owned attachment UX user missing");
    const login = await fetch(`${owned.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: owned.base, "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "owned-process-password-not-a-secret" }),
    });
    expect(login.status).toBe(200);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addCookies(
      login.headers.getSetCookie().map((value) => ({
        name: value.slice(0, value.indexOf("=")),
        value: value.slice(value.indexOf("=") + 1, value.indexOf(";")),
        url: owned.base,
      })),
    );
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/api/") && response.status() >= 400)
        failedReads.push({ path, status: response.status() });
    });
    await page.goto(owned.base);
    await openProjectMenu(page);
    await page
      .getByRole("button")
      .filter({ hasText: `build-turn-${f.projectID.replaceAll("-", "").slice(0, 12)}` })
      .click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.mouse.move(0, width === 390 ? 843 : 999);
      await visible(page.locator(".topbar-start .context-button")).toHaveCount(0);
      const dock = (await page.getByRole("navigation", { name: "Workspace dock" }).boundingBox())!;
      expect(Math.abs(dock.x + dock.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      const gear = page.getByRole("button", { name: "Settings", exact: true });
      const gearBox = (await gear.boundingBox())!;
      expect(
        Math.abs(dock.y + dock.height / 2 - gearBox.y - gearBox.height / 2),
      ).toBeLessThanOrEqual(1);
      await gear.click();
      await visible(
        page.getByRole("button", { name: "Open project menu", exact: true }),
      ).toContainText("Attachment UX");
      await visible(page.getByRole("region", { name: "Settings", exact: true })).toBeInViewport();
      await page.screenshot({
        path: resolve(directory, `settings-${width}.png`),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Open project menu", exact: true }).click();
      await visible(page.getByRole("region", { name: "Projects", exact: true })).toBeInViewport();
      await page.screenshot({
        path: resolve(directory, `project-switcher-${width}.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await visible(gear).toBeFocused();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const capture = async (name: string) => {
      await visible(page!.getByText(/Updates paused/)).toHaveCount(0);
      await visible(
        page!.getByText("Update failed. Your saved pages are still available.", { exact: true }),
      ).toHaveCount(0);
      for (const width of [1440, 768, 390]) {
        await page!.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await page!.screenshot({
          path: resolve(directory, `${name}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        expect(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (name === "feedback-draft" && width === 390) {
          const count = page!.locator(".review-composer .attachment-count");
          expect(
            await count.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          await visible(
            page!.getByRole("button", { name: "Scroll attachments right", exact: true }),
          ).not.toBeVisible();
          const save = page!.getByRole("button", { name: "Save feedback", exact: true });
          await save.scrollIntoViewIfNeeded();
          await visible(save).toBeInViewport();
          await page!.screenshot({ path: resolve(directory, "feedback-actions-390.png") });
        }
        if (name === "feedback-saved" && width === 390) {
          const file = page!.locator(".review-message-body a.factory-attachment-file").first();
          await file.scrollIntoViewIfNeeded();
          await visible(file).toBeInViewport();
          await page!.screenshot({ path: resolve(directory, "feedback-files-390.png") });
        }
      }
      await page!.setViewportSize({ width: 1440, height: 1000 });
    };
    await page
      .getByRole("button")
      .filter({ hasText: "Keep references with saved feedback" })
      .click();
    await visible(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
      "Keep references with saved feedback",
    );
    await visible(page.getByText("Loading review…", { exact: true })).toHaveCount(0);
    const reference = {
      name: "Feedback-reference.png",
      mimeType: "image/png",
      buffer: await page.screenshot({ path: resolve(directory, "reference.png") }),
    };
    const documentFile = {
      name: "Produktanforderungen_fuer_den_ersten_Projektstart_und_die_naechsten_gemeinsamen_Feedbackrunden_mit_dem_gesamten_Produktteam.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(
        attachmentPDF("Keep the submitted reference and its meaning with the saved feedback."),
      ),
    };
    const supportingFiles = [
      documentFile,
      {
        name: "Product-brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from(attachmentDOCX()),
      },
      {
        name: "Acceptance-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Keep the submitted reference and its meaning."),
      },
      {
        name: "Review-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("## Review notes\n\nDo not copy the temporary error state."),
      },
    ];
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Reference material", exact: true }).click();
    await page.getByRole("button", { name: "Edit Knowledge title", exact: true }).click();
    const wiki = page.getByRole("textbox", { name: "Knowledge body", exact: true });
    await visible(wiki).toBeVisible();
    const wikiHost = page.locator(".rich-editor-host").filter({ has: wiki });
    await wikiHost.getByLabel("Choose attachments").setInputFiles([reference, documentFile]);
    // Each real conversion has a 60-second worker deadline. Do not confuse
    // Playwright's five-second assertion default with attachment readiness.
    await visible(wikiHost.getByRole("button", { name: "Add image or file" })).toBeEnabled({
      timeout: 2 * 60_000,
    });
    await visible(wikiHost.getByRole("status")).toContainText("is ready");
    await visible(wiki.locator("img")).toBeVisible();
    await capture("wiki");

    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const composer = page.locator(".conversation-composer");
    await visible(composer).toBeVisible();
    const message = composer.getByRole("textbox", { name: "Message conversation", exact: true });
    await message.fill("Please compare these references. Keep the document's caveats.");
    const help = composer.getByLabel("Attachment formats and limits", { exact: true });
    await help.click();
    await visible(composer.locator(".attachment-restrictions")).toBeVisible();
    await visible(composer.locator(".attachment-restrictions")).toContainText("10 MiB per file");
    await visible(composer.locator(".attachment-restrictions")).toContainText("20 MiB total");
    await help.press("Escape");
    await visible(help).toBeFocused();
    await composer.getByLabel("Choose attachments").setInputFiles(reference);
    await visible(
      composer.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(1, { timeout: 60_000 });
    const oneFileHeights = new Map<number, number>();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      oneFileHeights.set(width, (await composer.boundingBox())!.height);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await composer.getByLabel("Choose attachments").setInputFiles(supportingFiles);
    await visible(
      composer.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(5, { timeout: 5 * 60_000 });
    await visible(message).toHaveValue(
      "Please compare these references. Keep the document's caveats.",
    );
    await visible(composer.locator(".attachment-count")).toContainText("5 files");
    await visible(composer.locator(".attachment-privacy")).toHaveCount(0);
    const files = composer.getByRole("list", { name: "Prepared attachments" });
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await visible(page.locator(".agent-panel")).toHaveAttribute(
        "role",
        width <= 900 ? "dialog" : "complementary",
      );
      const geometry = await files
        .locator("li")
        .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
      expect(Math.max(...geometry) - Math.min(...geometry)).toBeLessThan(1);
      const metadataOverlap = await files
        .locator("li")
        .evaluateAll((items) =>
          items.map(
            (item) =>
              item.querySelector(".attachment-file-ready")!.getBoundingClientRect().right -
              item.querySelector(".attachment-file-remove")!.getBoundingClientRect().left,
          ),
        );
      expect(Math.max(...metadataOverlap)).toBeLessThanOrEqual(0);
      expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(
        oneFileHeights.get(width)! + 2,
      );
      const attach = composer.getByRole("button", { name: "Add image or file", exact: true });
      const send = composer.getByRole("button", { name: "Send message", exact: true });
      const attachBox = (await attach.boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      expect(
        Math.abs(attachBox.y + attachBox.height / 2 - sendBox.y - sendBox.height / 2),
      ).toBeLessThanOrEqual(1);
      expect(attachBox.x).toBeLessThan(sendBox.x);
      expect((await attach.locator("svg").boundingBox())!.width).toBeLessThan(
        (await send.locator("svg").boundingBox())!.width,
      );
      const shell = await composer.evaluate((element) => {
        const rect = (element.closest(".agent-input-shell") ?? element).getBoundingClientRect();
        return { y: rect.y, height: rect.height };
      });
      const topPadding = (await files.locator("li").first().boundingBox())!.y - shell.y;
      const bottomPadding = shell.y + shell.height - sendBox.y - sendBox.height;
      expect(Math.abs(topPadding - bottomPadding)).toBeLessThanOrEqual(4);
      await files.focus();
      await visible(files).toBeFocused();
      await files.press("End");
      await visible.poll(() => files.evaluate((list) => list.scrollLeft)).toBeGreaterThan(0);
      await files.press("Home");
      await help.click();
      const panel = composer.locator(".attachment-help-content");
      await visible(panel).toBeInViewport();
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(width === 390 ? 844 : 1000);
      await page.screenshot({ path: resolve(directory, `chat-help-${width}.png`) });
      await help.press("Escape");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await visible(
      composer.getByRole("button", { name: "Choose a Skill for this message", exact: true }),
    ).toHaveCount(0);
    await message.fill("Please compare these references. Keep the document's caveats. /");
    const skillSuggestions = composer.getByRole("listbox", { name: "Available Skills" });
    await visible(skillSuggestions).toBeVisible();
    await visible(skillSuggestions.getByRole("status")).toHaveCount(0);
    await visible(skillSuggestions.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: resolve(directory, "chat-slash-1440.png") });
    await message.press("Escape");
    await message.fill("Please compare these references. Keep the document's caveats.");
    await visible(files.locator("li")).toHaveCount(5);
    await composer.getByRole("button", { name: "Scroll attachments right", exact: true }).click();
    await visible.poll(() => files.evaluate((list) => list.scrollLeft)).toBeGreaterThan(0);
    await files.focus();
    await files.press("Home");
    const openImage = composer.getByRole("link", {
      name: "Open image Feedback-reference.png",
      exact: true,
    });
    await openImage.focus();
    const openedImage = context.waitForEvent("page");
    await openImage.press("Enter");
    const original = await openedImage;
    await original.waitForLoadState("load");
    expect(original.url()).toContain("/api/attachments/");
    const fullImage = original.locator("img");
    await visible(fullImage).toBeVisible();
    expect(await fullImage.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1440);
    await original.screenshot({ path: resolve(directory, "image-original-1440.png") });
    await original.close();
    await capture("chat-ready");
    await composer.getByLabel("Choose attachments").setInputFiles({
      name: "Too-large.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await visible(composer.getByRole("alert")).toContainText("10 MiB");
    await visible(composer.getByRole("alert")).toContainText("Too-large.pdf");
    await visible(
      composer.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(5);
    await page.getByRole("button", { name: "Minimize Agent panel", exact: true }).click();
    await openProjectMenu(page);
    await page
      .getByRole("region", { name: "Projects" })
      .getByRole("button")
      .filter({
        hasText: otherSlug,
      })
      .click();
    await openProjectMenu(page);
    await page
      .getByRole("region", { name: "Projects" })
      .getByRole("button")
      .filter({
        hasText: `build-turn-${f.projectID.replaceAll("-", "").slice(0, 12)}`,
      })
      .click();
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await visible(message).toHaveValue(
      "Please compare these references. Keep the document's caveats.",
    );
    await visible(
      composer.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(5);
    await visible.poll(() => message.inputValue()).toContain("Keep the document's caveats.");
    await capture("chat-too-large");
    await page.getByRole("button", { name: "Minimize Agent panel", exact: true }).click();
    await page
      .getByRole("tab", { name: "Keep references with saved feedback", exact: true })
      .click();
    const ticket = page.locator(".ticket-workspace");
    await visible(ticket.getByText("Loading review…", { exact: true })).toHaveCount(0);
    await visible(ticket.getByRole("button", { name: "Add feedback", exact: true })).toBeVisible();
    const action = async (name: string) => {
      const direct = ticket.getByRole("button", { name, exact: true });
      if (await direct.isVisible()) return direct.click();
      await ticket.getByRole("button", { name: "Ticket actions", exact: true }).click();
      await page!.getByRole("menuitem", { name, exact: true }).click();
    };
    await action("Add feedback");
    const feedback = page.getByRole("form", { name: "Add review feedback" });
    await feedback
      .getByRole("textbox", { name: "Review comment" })
      .fill("Keep this layout, but do not copy the temporary error state in the reference.");
    await feedback.getByLabel("Choose attachments").setInputFiles([reference, ...supportingFiles]);
    await visible(
      feedback.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(5, { timeout: 5 * 60_000 });
    await visible(feedback.getByRole("textbox", { name: "Review comment" })).toHaveValue(
      "Keep this layout, but do not copy the temporary error state in the reference.",
    );
    await capture("feedback-draft");
    await feedback.getByLabel("Feedback type").selectOption("thread");
    await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible(ticket.locator(".review-message-body img")).toBeVisible();
    const savedImage = ticket.getByRole("link", {
      name: "Open image Feedback-reference.png in new tab",
      exact: true,
    });
    await visible(savedImage).toHaveAttribute("target", "_blank");
    await visible(ticket.locator(".review-message-body")).not.toContainText("/api/attachments/");
    await capture("feedback-saved");
    await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await visible(message).toHaveValue(
      "Please compare these references. Keep the document's caveats.",
    );
    await visible(
      composer.getByRole("list", { name: "Prepared attachments" }).locator("li"),
    ).toHaveCount(5);
    const expectedFiles = await composer
      .locator(".attachment-file-open")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
    const attempts: { text: string; commandId: string }[] = [];
    await page.route(
      `${owned.base}/api/projects/${f.projectID}/conversation/message`,
      async (route) => {
        attempts.push(route.request().postDataJSON());
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Owned fixture: send is unconfirmed. Retry the same request.",
          }),
        });
      },
    );
    for (let attempt = 1; attempt <= 2; attempt++) {
      await composer.getByRole("button", { name: "Send message", exact: true }).click();
      await visible.poll(() => attempts.length).toBe(attempt);
      await visible(message).toBeEnabled();
      await visible(message).toHaveValue(
        "Please compare these references. Keep the document's caveats.",
      );
      await visible(
        composer.getByRole("list", { name: "Prepared attachments" }).locator("li"),
      ).toHaveCount(5);
    }
    expect(attachmentIDs(attempts[0]!.text).sort()).toEqual(
      attachmentIDs(expectedFiles.join("\n")).sort(),
    );
    expect(attempts[0]!.text).toContain("Keep the document's caveats.");
    expect(attempts[0]!.commandId).toBe(attempts[1]!.commandId);
    const [turns] = await database.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM factory.agent_turn WHERE project_id=${fixture.projectID}`;
    expect(turns?.count).toBe(1);
    expect(errors).toEqual([]);
    completed = true;
    await Bun.write(
      resolve(directory, "result.json"),
      JSON.stringify({ result: "passed", directory, projectID: f.projectID, errors }, null, 2),
    );
    if (process.env["FACTORY_ATTACHMENT_UX_REVIEW"] === "1") {
      const stopFile = resolve(directory, "stop");
      await Bun.write(
        resolve(".factory/test-results/attachment-ux/session.json"),
        JSON.stringify({
          base: owned.base,
          directory,
          stopFile,
          email: user.email,
          projectID: f.projectID,
          ticketID: f.ticketID,
          pageID,
        }),
      );
      console.log(`Owned attachment UX review ready: ${directory}`);
      while (!(await Bun.file(stopFile).exists())) await Bun.sleep(250);
    }
    console.log(`Full Factory attachment evidence: ${directory}`);
  } finally {
    if (page && !completed) {
      await page.screenshot({ path: resolve(directory, "failure.png") }).catch(() => {});
      await Bun.write(resolve(directory, "failure.json"), JSON.stringify({ errors, failedReads }));
    }
    try {
      await browser.close();
      await owned.shutdown();
      // Disposing this owned database also removes its extra Wiki references.
      await database.client.end();
      await owned.dispose();
    } finally {
      try {
        await s3.dispose();
      } finally {
        await forge.stop(true);
        const sessionPath = resolve(".factory/test-results/attachment-ux/session.json");
        const session = (await Bun.file(sessionPath)
          .json()
          .catch(() => null)) as { directory?: string } | null;
        if (session?.directory === directory) await rm(sessionPath, { force: true });
      }
    }
  }
}, 1_800_000);
