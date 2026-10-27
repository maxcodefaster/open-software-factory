import { mockFactoryFunctions } from "../fixtures/server-functions";
import {
  attemptsResponseSchema,
  appPreviewsSchema,
  deliveryViewSchema,
} from "../../apps/factory/src/api-contracts";
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as visible } from "@playwright/test";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import {
  previewBridgeResponse,
  previewRendererResponse,
  scopeRuntimeEmbedding,
} from "../../apps/factory/src/runtime/embedding";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { factoryProcess } from "../fixtures/factory-process";
import { openProjectMenu } from "../fixtures/project-menu";
import { ownedAttachmentS3 } from "../fixtures/attachment-s3";
import { fixtureValue } from "../fixtures/value";

// Real Factory entry, auth, planning cache, Ticket and review commands. Only the
// runtime observation/transport is scripted; this test starts no Sandbox or model.
test("review fits the actual Factory Ticket and retains human work in its existing Preview tab", async () => {
  const s3 = await ownedAttachmentS3();
  const owned = await factoryProcess().catch(async (cause) => {
    await s3.dispose();
    throw cause;
  });
  const directory = resolve(".factory/test-results/visual-review-factory", owned.id);
  await mkdir(directory, { recursive: true });
  const database = owned.connect();
  const browser = await chromium.launch({ headless: true });
  let f: Awaited<ReturnType<typeof candidateReviewFixture>> | undefined;
  let page: import("@playwright/test").Page | undefined;
  let completed = false;
  const errors: string[] = [];
  const reviewWrites: Array<{ path: string; status: number; response: string }> = [];
  try {
    await owned.startPlanningCache();
    await owned.start();
    f = await candidateReviewFixture(
      canonicalRequirementContent({
        summary: "Keep the user's draft when validation fails.",
        acceptanceCriteria: [
          "An empty title shows an error without clearing the draft.",
          "A valid title saves once and preserves the entered text.",
        ],
        nonGoals: ["Change the underlying storage service."],
      }),
      database,
    );
    const fixture = f;
    await database.client`UPDATE auth."user" SET name='Mara Fischer' WHERE id=${fixture.userID}`;
    const title = "Keep a draft after validation fails";
    await database.client`UPDATE factory.ticket SET title=${title},state='ready' WHERE id=${fixture.ticketID}`;
    await database.client`UPDATE factory.project SET name='Review workspace' WHERE id=${fixture.projectID}`;
    await database.client`INSERT INTO factory.branch_create_operation(
      id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','review',branch_name,base_sha,${`owned-review:${owned.id}`},'succeeded',base_sha,now()
      FROM factory.change WHERE id=${fixture.changeID}`;
    await database.client`INSERT INTO auth.account(id,account_id,provider_id,user_id,password)
      SELECT ${crypto.randomUUID()},${fixture.userID},'credential',${fixture.userID},password
      FROM auth.account WHERE user_id='01994a7d-0000-7000-8000-000000000001' AND provider_id='credential'`;
    const [user] = await database.client<
      { email: string }[]
    >`SELECT email FROM auth."user" WHERE id=${fixture.userID}`;
    const login = await fetch(`${owned.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: owned.base, "content-type": "application/json" },
      body: JSON.stringify({
        email: fixtureValue(user, "user").email,
        password: "owned-process-password-not-a-secret",
      }),
    });
    expect(login.status).toBe(200);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.grantPermissions(["local-network-access"], { origin: owned.base });
    await context.addCookies(
      login.headers.getSetCookie().map((value) => ({
        name: value.slice(0, value.indexOf("=")),
        value: value.slice(value.indexOf("=") + 1, value.indexOf(";")),
        url: owned.base,
      })),
    );
    await context.addInitScript(() => {
      Object.assign(window, { screenSharingRequests: 0 });
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: async () => {
          (window as unknown as { screenSharingRequests: number }).screenSharingRequests++;
          throw new Error("Review must not request screen sharing");
        },
      });
    });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (
        response.request().method() !== "POST" ||
        (!path.includes("/review/") &&
          !/\/_server\/data\/(?:createReviewFeedback|updateReviewFeedback|sendReviewRevision)-/.test(
            path,
          ))
      )
        return;
      void response
        .text()
        .then((text) => {
          reviewWrites.push({ path, status: response.status(), response: text.slice(0, 1000) });
        })
        .catch(() => {});
    });
    const runtimeOrigin = appRuntimeOrigin(owned.base, fixture.attemptID, "app");
    const runtimePath = `/runtime/${fixture.attemptID}/preview/app/`;
    await mockFactoryFunctions(page, {
      runtime: {
        attempts: async () =>
          attemptsResponseSchema.parse({
            attempts: [
              {
                id: fixture.attemptID,
                projectId: fixture.projectID,
                changeId: fixture.changeID,
                state: "ready",
                runtimeKind: "ticket",
                workspaceKind: "ticket",
                workspaceId: fixture.attemptID,
              },
            ],
          }),
      },
    });
    await mockFactoryFunctions(page, {
      runtime: {
        previews: async () =>
          appPreviewsSchema.parse({
            previews: [
              {
                attemptID: fixture.attemptID,
                projectID: fixture.projectID,
                channel: "app",
                label: "Draft form",
              },
            ],
          }),
      },
    });
    await page.route("**/api/runtime-access?*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(`${runtimeOrigin}${runtimePath}`)})</script>`,
      }),
    );
    await page.route(`${runtimeOrigin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/__factory/review-bridge.js")) {
        const response = previewBridgeResponse(owned.base);
        return route.fulfill({
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        });
      }
      if (path.endsWith("/__factory/review-renderer.js")) {
        const response = previewRendererResponse();
        return route.fulfill({
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        });
      }
      const response = scopeRuntimeEmbedding(
        new Response(
          '<!doctype html><title>Draft form fixture</title><style>body{font:16px sans-serif;padding:40px;background:#f7f5ef}label{display:block;margin:24px 0}button,input{font:inherit;padding:10px}</style><h1>Draft form</h1><p>Scripted App transport, not a live QA run.</p><label>Project title <input value="My draft"></label><button>Save draft</button>',
          {
            headers: {
              "content-type": "text/html",
              "content-security-policy":
                "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:",
            },
          },
        ),
        owned.base,
        `${runtimePath}__factory/review-bridge.js`,
      );
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
    // An independently owned browser generates a playable test recording, not AI evidence.
    const recorded = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: resolve(directory, "fixture-video"), size: { width: 1280, height: 720 } },
    });
    const appPage = await recorded.newPage();
    const videoFile = fixtureValue(appPage.video(), "appPage.video()");
    await appPage.setContent(
      '<style>body{font:22px sans-serif;padding:48px;background:#f7f5ef}input,button{font:inherit;padding:10px}</style><h1>Draft form</h1><p>Scripted QA recording fixture</p><label>Project title <input value="My draft"></label><button>Save draft</button>',
    );
    await appPage.getByRole("textbox").fill("");
    await appPage.getByRole("button").click();
    await appPage.waitForTimeout(1200);
    const still = await appPage.screenshot({ type: "jpeg" });
    await recorded.close();
    const video = await Bun.file(await videoFile.path()).bytes();
    const recordingID = crypto.randomUUID();
    await database.client`INSERT INTO factory.review_media(id,change_id,review_id,kind,commit_sha,runtime_attempt_id,state)
      VALUES(${recordingID},${fixture.changeID},${fixture.reviewID},'recording',${fixture.commit},${fixture.attemptID},'intended')`;
    const media = createReviewMedia(database);
    await media.publish(recordingID, video, 2000);
    for (const [id, name, category, position] of [
      ["save", "Save a draft", "normal", 0],
      ["empty", "Empty title", "error", 400],
      ["retry", "Retry after validation", "boundary", 800],
    ] as const) {
      await database.client`INSERT INTO factory.review_scenario(review_id,id,title,category,criterion,expected,status,ended_at,media_started_ms,observed)
        VALUES(${fixture.reviewID},${id},${name},${category},1,'The entered draft stays visible.','passed',now(),${position},'The draft remains in the form.')`;
    }
    const review = createVisualReviewController(database, media.bytes);
    const original = await media.still(
      fixture.changeID,
      fixture.userID,
      {
        source: "recording",
        recordingId: recordingID,
        timestampMs: 800,
      },
      new Uint8Array(still),
    );
    const thread = await review.create(fixture.changeID, fixture.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Keep the draft and show the validation error beside the title.",
      annotation: {
        source: "recording",
        mediaId: original.id,
        page: "/form",
        timestampMs: 800,
        region: { x: 0.3, y: 0.19, width: 0.001, height: 0.001 },
      },
    });
    await review.update(fixture.changeID, fixture.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: thread.feedbackId,
      expectedVersion: 1,
      action: "reply",
      body: "Also checked after retrying. The entered text should stay.",
    });
    await review.create(fixture.changeID, fixture.userID, {
      commandId: crypto.randomUUID(),
      kind: "comment",
      body: "The rest of the flow is clear.",
    });
    await page.goto(owned.base);
    await openProjectMenu(page);
    await page
      .getByRole("button")
      .filter({ hasText: `build-turn-${fixture.projectID.replaceAll("-", "").slice(0, 12)}` })
      .click();
    await page
      .getByRole("region", { name: "Ticket board" })
      .getByRole("button")
      .filter({ hasText: title })
      .click();
    const panel = page
      .getByRole("region", { name: "Visual review", exact: true })
      .filter({ has: page.locator(".review-recording") });
    await visible(panel.getByRole("button", { name: "Comment", exact: true })).toBeEnabled();
    await visible(page.locator(".ticket-checks > summary")).toContainText("Independent review");
    const toolbar = page.locator(".ticket-header-actions");
    async function headerAction(name: string) {
      const button = toolbar.getByRole("button", { name, exact: true });
      if (await button.isVisible()) await button.click();
      else {
        await toolbar.getByRole("button", { name: "Ticket actions", exact: true }).click();
        await fixtureValue(page, "page").getByRole("menuitem", { name, exact: true }).click();
      }
    }
    const primary = toolbar.getByRole("button", {
      name: /^Request revision · \d+ Threads?$/,
    });
    await visible(primary).toBeVisible();
    await visible(
      panel.getByRole("button", { name: /^Request revision · \d+ Threads?$/ }),
    ).toHaveCount(0);
    const buttonStyle = await primary.evaluate((node) => {
      function fixtureValue<T>(value: T, description: string): NonNullable<T> {
        if (value === undefined || value === null)
          throw new Error(`Missing fixture value: ${description}`);
        return value;
      }

      const reference = document.createElement("button");
      reference.className = "workspace-action ticket-header-action";
      reference.setAttribute("data-primary", "true");
      reference.textContent = "Implement";
      fixtureValue(node.parentElement, "node.parentElement").append(reference);
      const values = (element: Element) => {
        const style = getComputedStyle(element);
        return [
          style.backgroundColor,
          style.color,
          style.borderRadius,
          style.minHeight,
          style.padding,
        ];
      };
      const result = { actual: values(node), standard: values(reference) };
      reference.remove();
      return result;
    });
    expect(buttonStyle.actual).toEqual(buttonStyle.standard);
    expect(buttonStyle.actual[0]).toBe("rgba(0, 0, 0, 0)");
    await visible(toolbar.locator(":scope > :first-child > button")).toHaveAttribute(
      "aria-label",
      "Ticket actions",
    );
    await visible(toolbar.locator(":scope > :last-child")).toHaveAttribute("data-primary", "true");
    await visible(toolbar.locator("svg")).toHaveCount(1);
    const headerBounds = await page.locator(".ticket-status-row").boundingBox();
    const primaryBounds = await primary.boundingBox();
    expect(
      fixtureValue(primaryBounds, "primaryBounds").y - fixtureValue(headerBounds, "headerBounds").y,
    ).toBeLessThanOrEqual(4);
    expect(
      fixtureValue(primaryBounds, "primaryBounds").x +
        fixtureValue(primaryBounds, "primaryBounds").width,
    ).toBeGreaterThan(
      fixtureValue(headerBounds, "headerBounds").x +
        fixtureValue(headerBounds, "headerBounds").width -
        60,
    );
    expect(
      await page
        .locator(".ticket-document")
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingTop)),
    ).toBeLessThanOrEqual(16);
    expect(
      await panel
        .locator(".review-layout")
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingTop)),
    ).toBeLessThanOrEqual(8);
    await visible(panel.getByRole("checkbox")).toHaveCount(0);
    await visible(page.locator(".ticket-checks .check-indicator")).toHaveCount(0);
    await visible(panel.getByRole("heading", { name: "Feedback", exact: true })).toHaveCount(0);
    await visible(panel.getByText("Open Thread", { exact: true })).toHaveCount(0);
    await visible(panel.locator(".ticket-header-actions")).toHaveCount(0);
    await visible(toolbar.getByRole("button", { name: "Add feedback", exact: true })).toBeVisible();
    await visible(toolbar.getByRole("button", { name: "Open Live Preview" })).toBeVisible();
    await visible(page.getByRole("status", { name: "Ticket progress" })).toContainText(
      "Implementation passed its checks. Independent review",
    );
    const requirements = page.getByRole("region", { name: "Ticket requirements", exact: true });
    await visible(requirements.getByRole("heading", { name: "Product", exact: true })).toHaveCount(
      1,
    );
    await visible(
      requirements.getByRole("textbox", { name: "Specification summary", exact: true }),
    ).toHaveText("Keep the user's draft when validation fails.");
    await visible(
      requirements.getByRole("region", { name: "Specification", exact: true }),
    ).toHaveCount(1);
    const requirementsBounds = await requirements.boundingBox();
    const panelBounds = await panel.boundingBox();
    expect(
      Math.abs(
        fixtureValue(requirementsBounds, "requirementsBounds").x -
          fixtureValue(panelBounds, "panelBounds").x,
      ),
    ).toBeLessThanOrEqual(1);
    expect(fixtureValue(requirementsBounds, "requirementsBounds").y).toBeGreaterThanOrEqual(
      fixtureValue(panelBounds, "panelBounds").y + fixtureValue(panelBounds, "panelBounds").height,
    );
    await visible(page.getByRole("button", { name: "Request changes", exact: true })).toHaveCount(
      0,
    );
    await visible(page.getByRole("heading", { name: "QA & review", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await visible(page.getByRole("menuitem", { name: "Open IDE", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await visible(
      page
        .locator(".ticket-status-context")
        .getByText("1 open Thread blocks Delivery", { exact: true }),
    ).toBeVisible();
    await visible(panel.getByText("1 open Thread blocks Delivery", { exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Play QA recording", exact: true }).click();
    await visible
      .poll(() => panel.locator("video").evaluate((node) => (node as HTMLVideoElement).currentTime))
      .toBeGreaterThan(0.2);
    await panel.locator("video").evaluate((node) => (node as HTMLVideoElement).pause());
    await panel.getByRole("button", { name: /QA feedback 1 at/ }).click();
    await visible(panel.getByRole("article", { name: /thread by/ })).toBeFocused();
    const progress = await panel.locator("video").evaluate((node) => {
      const video = node as HTMLVideoElement;
      return video.currentTime / video.duration;
    });
    await visible
      .poll(() =>
        panel.locator(".review-timeline-track > span").evaluate((node) => {
          function fixtureValue<T>(value: T, description: string): NonNullable<T> {
            if (value === undefined || value === null)
              throw new Error(`Missing fixture value: ${description}`);
            return value;
          }
          return (
            node.getBoundingClientRect().width /
            fixtureValue(node.parentElement, "node.parentElement").getBoundingClientRect().width
          );
        }),
      )
      .toBeCloseTo(progress, 1);
    await visible(panel.locator(".review-reply-list .review-message")).toHaveCount(1);
    await visible(panel.locator(".review-feedback details")).toHaveCount(0);
    await visible(panel.getByText("Context", { exact: true })).toHaveCount(0);
    await visible(panel.locator(".review-scenario-summary dt")).toHaveText([
      "Expected",
      "Observed",
    ]);
    await visible(panel.locator(".review-scenario-summary dd")).toHaveText([
      "The entered draft stays visible.",
      "The draft remains in the form.",
    ]);
    await page.screenshot({ path: resolve(directory, "ticket-desktop.png") });
    await panel.getByRole("button", { name: "View saved QA frame", exact: true }).click();
    await visible(panel.getByRole("dialog", { name: "Saved feedback context" })).toBeVisible();
    await page.screenshot({ path: resolve(directory, "ticket-context-desktop.png") });
    await page.keyboard.press("Escape");
    await headerAction("Add feedback");
    const draft = panel.getByRole("textbox", { name: "Review comment" });
    await visible(draft).toBeFocused();
    await draft.fill("An unsent Ticket comment.");
    await draft.press("Escape");
    await headerAction("Add feedback");
    await visible(draft).toHaveValue("An unsent Ticket comment.");
    await headerAction("Open Live Preview");
    const app = page.frameLocator('iframe[title="Factory Preview"]');
    await app.getByRole("textbox").fill("Human input stays in the App");
    await page.screenshot({ path: resolve(directory, "preview-desktop.png") });
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    // Comment mode owns keyboard input, not the App's form.
    await visible(
      page.getByText("Hover an element and click. Tab and Enter also work. Esc exits."),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const popup = page.locator(".preview-comment-popover");
    await visible(popup.getByRole("textbox", { name: "Review comment" })).toBeFocused();
    await popup
      .getByRole("textbox", { name: "Review comment" })
      .fill("A Preview comment at this element.");
    await page.screenshot({ path: resolve(directory, "preview-comment-desktop.png") });
    await page.getByRole("button", { name: "Feedback in Ticket" }).click();
    await visible(draft).toHaveValue("An unsent Ticket comment.");
    await headerAction("Open Live Preview");
    await visible(popup.getByRole("textbox", { name: "Review comment" })).toHaveValue(
      "A Preview comment at this element.",
    );
    await visible(app.getByRole("textbox")).toHaveValue("Human input stays in the App");
    await visible(page.getByRole("tab", { name: /Preview ·/ })).toHaveCount(1);
    await popup.getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible
      .poll(async () => (await review.get(fixture.changeID, fixture.userID)).feedback.length, {
        timeout: 30_000,
      })
      .toBe(3);
    await page.getByRole("button", { name: "Feedback in Ticket" }).click();
    await visible(
      panel.getByText("A Preview comment at this element.", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Cancel feedback" }).click();
    for (const width of [900, 430]) {
      await page.setViewportSize({ width, height: 1000 });
      await panel.getByRole("slider", { name: "QA timeline" }).focus();
      await panel.getByRole("slider", { name: "QA timeline" }).press("Home");
      await panel.getByRole("button", { name: "Play QA recording", exact: true }).click();
      await visible
        .poll(() =>
          panel.locator("video").evaluate((node) => (node as HTMLVideoElement).currentTime),
        )
        .toBeGreaterThan(0.2);
      await panel.locator("video").evaluate((node) => (node as HTMLVideoElement).pause());
      await page.screenshot({ path: resolve(directory, `ticket-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.setViewportSize({ width: 430, height: 1000 });
    await panel.locator(".review-discussion").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, "ticket-discussion-narrow.png") });
    await panel.getByRole("button", { name: /^Live Preview ·/ }).click();
    const savedContext = panel.getByRole("dialog", { name: "Saved feedback context" });
    await visible(savedContext).toBeVisible();
    await visible(savedContext.getByRole("img")).toBeVisible();
    await page.screenshot({ path: resolve(directory, "ticket-context-narrow.png") });
    const contextBounds = await savedContext.boundingBox();
    const ticketBounds = await page.locator(".ticket-workspace").boundingBox();
    expect(fixtureValue(contextBounds, "contextBounds").y).toBeGreaterThanOrEqual(
      Math.max(0, fixtureValue(ticketBounds, "ticketBounds").y),
    );
    expect(
      fixtureValue(contextBounds, "contextBounds").y +
        fixtureValue(contextBounds, "contextBounds").height,
    ).toBeLessThanOrEqual(
      Math.min(
        1000,
        fixtureValue(ticketBounds, "ticketBounds").y +
          fixtureValue(ticketBounds, "ticketBounds").height,
      ),
    );
    await page.setViewportSize({ width: 320, height: 640 });
    await panel.getByRole("button", { name: /^Live Preview ·/ }).scrollIntoViewIfNeeded();
    await visible
      .poll(() =>
        savedContext.evaluate((node) => {
          function fixtureValue<T>(value: T, description: string): NonNullable<T> {
            if (value === undefined || value === null)
              throw new Error(`Missing fixture value: ${description}`);
            return value;
          }

          const bounds = node.getBoundingClientRect();
          const viewport = fixtureValue(
            node.closest(".ticket-workspace"),
            'node.closest(".ticket-workspace")',
          ).getBoundingClientRect();
          return (
            bounds.top >= Math.max(0, viewport.top) &&
            bounds.bottom <= Math.min(innerHeight, viewport.bottom)
          );
        }),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 320, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 430, height: 1000 });
    await headerAction("Add feedback");
    await visible(draft).toBeFocused();
    await draft.fill("General narrow Ticket feedback");
    await visible(panel.getByRole("button", { name: "Save feedback", exact: true })).toBeEnabled();
    const generalBounds = await draft.boundingBox();
    expect(fixtureValue(generalBounds, "generalBounds").y).toBeGreaterThanOrEqual(0);
    expect(
      fixtureValue(generalBounds, "generalBounds").y +
        fixtureValue(generalBounds, "generalBounds").height,
    ).toBeLessThanOrEqual(1000);
    await page.screenshot({ path: resolve(directory, "ticket-general-comment-narrow.png") });
    await panel.getByRole("button", { name: "Cancel feedback" }).click();
    const playhead = await panel
      .locator("video")
      .evaluate((node) => (node as HTMLVideoElement).currentTime);
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    await panel
      .getByRole("button", { name: "Choose a point on the paused QA frame" })
      .press("Enter");
    await visible(draft).toBeFocused();
    await draft.fill("Feedback on this exact QA moment.");
    await visible(panel.getByRole("button", { name: "Save feedback", exact: true })).toBeEnabled();
    const frameBounds = await draft.boundingBox();
    expect(fixtureValue(frameBounds, "frameBounds").y).toBeGreaterThanOrEqual(0);
    expect(
      fixtureValue(frameBounds, "frameBounds").y + fixtureValue(frameBounds, "frameBounds").height,
    ).toBeLessThanOrEqual(1000);
    await visible
      .poll(() => panel.locator("video").evaluate((node) => (node as HTMLVideoElement).currentTime))
      .toBeCloseTo(playhead, 1);
    await page.screenshot({ path: resolve(directory, "ticket-video-comment-narrow.png") });
    await panel.getByRole("button", { name: "Cancel feedback" }).click();
    await headerAction("Open Live Preview");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await app.getByRole("textbox").click();
    await popup.getByRole("textbox", { name: "Review comment" }).fill("Narrow Preview draft");
    await visible(popup.getByRole("button", { name: "Save feedback", exact: true })).toBeEnabled();
    await page.screenshot({ path: resolve(directory, "preview-comment-narrow.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { screenSharingRequests: number }).screenSharingRequests,
      ),
    ).toBe(0);
    await page.getByRole("button", { name: "Feedback in Ticket" }).click();
    let progressView = deliveryViewSchema.parse({
      verificationState: "failed",
      verificationFailureKind: "execution-failed",
      verificationSummary: "The Verification runner could not execute its checks.",
    });
    await mockFactoryFunctions(page, { delivery: { get: async () => progressView } });
    const progressStatus = page.getByRole("status", { name: "Ticket progress" });
    for (const stage of [
      {
        name: "execution",
        view: { verificationState: "failed", verificationFailureKind: "execution-failed" },
        text: "application correctness remains unverified",
      },
      {
        name: "correction",
        view: {
          verificationState: "failed",
          verificationFailureKind: "check-failed",
          verificationSummary: "Verification failed in Project checks: Validate invoice.",
          correctionState: "running",
        },
        text: "Automatic correction is in progress",
      },
      {
        name: "review",
        view: { verificationState: "succeeded", reviewState: "passed", openReviewThreads: 1 },
        text: "Recheck and resolve the open Threads",
      },
    ]) {
      progressView = deliveryViewSchema.parse(stage.view);
      await database.client`SELECT factory.touch_read_version(${fixture.projectID},'lifecycle',${fixture.projectID})`;
      await visible(progressStatus).toContainText(stage.text, { timeout: 15_000 });
      for (const width of [1440, 430]) {
        await page.setViewportSize({ width, height: 1000 });
        await progressStatus.scrollIntoViewIfNeeded();
        await visible(progressStatus).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: resolve(directory, `ticket-progress-${stage.name}-${width}.png`),
        });
      }
    }
    expect(errors).toEqual([]);
    const [turns] = await database.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.agent_turn WHERE change_id=${fixture.changeID}`;
    expect(turns?.count).toBe(1);
    completed = true;
  } finally {
    if (page && !completed) {
      await page.screenshot({ path: resolve(directory, "failure.png") }).catch(() => {});
      await writeFile(
        resolve(directory, "failure.json"),
        JSON.stringify(
          {
            errors,
            reviewWrites,
            video: await page
              .locator("video")
              .evaluate((node) => {
                const video = node as HTMLVideoElement;
                return {
                  readyState: video.readyState,
                  networkState: video.networkState,
                  error: video.error?.message,
                };
              })
              .catch(() => null),
          },
          null,
          2,
        ),
      );
    }
    try {
      await browser.close();
      await owned.shutdown();
      if (f) {
        await database.client`DELETE FROM factory.branch_create_operation WHERE change_id=${f.changeID}`;
        await f.dispose();
      } else await database.client.end();
      await owned.dispose();
    } finally {
      await s3.dispose();
    }
  }
}, 180_000);
