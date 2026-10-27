import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium, expect as visible } from "@playwright/test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { CommandError } from "../../apps/factory/src/command-error";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { createReviewService } from "../../apps/factory/src/review/service";
import {
  previewBridgeResponse,
  previewRendererResponse,
  scopeRuntimeEmbedding,
} from "../../apps/factory/src/runtime/embedding";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { visualReviewSchema } from "../../packages/conversation-domain/src/visual-review";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import { compiledFactoryEndpoint } from "../fixtures/server-functions";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { fixtureValue } from "../fixtures/value";
import { productionBuildEnvironment } from "../../scripts/testing/test-prerequisites";

test("Ticket video, shared feedback and permission-free Preview comments work in the Factory shell", async () => {
  const f = await candidateReviewFixture();
  const directory = resolve(".factory/test-results/visual-review-browser", f.projectID);
  await mkdir(directory, { recursive: true });
  const buildDirectory = resolve(directory, "frontend");
  const frontend = resolve(buildDirectory, "client");
  const media = createReviewMedia(f.database, memoryPrivateObjects());
  const review = createVisualReviewController(f.database, media.bytes);
  const recordingID = crypto.randomUUID();
  let base = "";
  let saves = 0;
  let loseFeedbackResponse = false;
  let blockContextImage = false;
  let blockBridge = false;
  let failStillUpload = false;
  let failReview = true;
  let failVideo = false;
  let revisionRequests = 0;
  let loseRevisionResponse = false;
  let delayedReply:
    | {
        saved: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let unavailable: "missing" | "unavailable" | "deleted" | undefined;
  let functions: Awaited<ReturnType<typeof compiledFactoryEndpoint>>;
  const service = createReviewService({
    controller: review,
    access: createAccessController(f.database),
    admit: async (changeID, userID, sql, text, commandId) =>
      (
        await createChangeAdmission(f.database, buildModelID).admitIn(sql, changeID, userID, {
          kind: "change-prompt",
          commandId,
          text,
        })
      ).turn.id,
    dispatchPending: async () => {},
  });
  const build = Bun.spawn(
    [
      "node",
      resolve("node_modules/vite/bin/vite.js"),
      "build",
      "--config",
      resolve("test/fixtures/visual-review-vite.config.ts"),
      "--outDir",
      buildDirectory,
    ],
    { env: productionBuildEnvironment(process.env), stdout: "ignore", stderr: "pipe" },
  );
  const buildError = await new Response(build.stderr).text();
  if (await build.exited)
    throw new Error(`Owned review UI build failed: ${buildError.slice(-1000)}`);
  if (!(await Bun.file(resolve(frontend, "visual-review.html")).exists()))
    throw new Error("Owned review UI build did not emit its component entry");
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/_server/")) return functions(request);
        if (url.pathname === "/api/runtime-access") {
          const path = url.searchParams.get("path");
          if (!path?.startsWith(`/runtime/${f.attemptID}/`))
            return new Response(null, { status: 404 });
          return Response.redirect(`${appRuntimeOrigin(base, f.attemptID, "app")}${path}`);
        }
        if (url.pathname.startsWith("/art/")) {
          const path = resolve("apps/factory/public", url.pathname.slice(1));
          if (!path.startsWith(resolve("apps/factory/public/art") + sep))
            return new Response(null, { status: 404 });
          return new Response(Bun.file(path));
        }
        if (url.pathname.endsWith("/fixture.js"))
          return new Response(
            'document.body.dataset.clicks="0";document.querySelector("button").addEventListener("click",()=>document.body.dataset.clicks=String(Number(document.body.dataset.clicks)+1));',
            { headers: { "content-type": "text/javascript" } },
          );
        if (url.pathname.endsWith("/__factory/review-bridge.js"))
          return previewBridgeResponse(base);
        if (url.pathname.endsWith("/__factory/review-renderer.js"))
          return blockContextImage
            ? new Response(null, { status: 503 })
            : previewRendererResponse();
        const runtimePath = url.pathname.startsWith(`/runtime/${f.attemptID}/preview/app/`)
          ? `/runtime/${f.attemptID}/preview/app/`
          : `/runtime/${f.attemptID}/app/`;
        if (url.pathname.startsWith(runtimePath))
          return scopeRuntimeEmbedding(
            new Response(
              '<!doctype html><title>Human Preview fixture</title><style>body{font:16px sans-serif;background:#f7f5ef;padding:32px}button,input{font:inherit;padding:10px}label{display:block;margin:24px 0}</style><h1>Delivery form</h1><label>Project title <input id="project-title" value="Retained draft"></label><button>Save draft</button><p>Scripted App. Preview belongs to this human browser.</p><script src="fixture.js"></script>',
              {
                headers: {
                  "content-type": "text/html",
                  "content-security-policy": `default-src 'self'; style-src 'unsafe-inline'; script-src ${blockBridge ? "'none'" : "'self'"}; img-src 'self' data: blob:`,
                },
              },
            ),
            base,
            `${runtimePath}__factory/review-bridge.js`,
          );
        const path = `/api/changes/${f.changeID}/review`;
        if (url.pathname.startsWith(`${path}/media/`)) {
          if (failVideo && url.pathname.endsWith(recordingID))
            return new Response(null, { status: 503 });
          return media.read(
            f.changeID,
            f.userID,
            fixtureValue(url.pathname.split("/").at(-1), 'url.pathname.split("/").at(-1)'),
            request.headers.get("range"),
          );
        }
        if (url.pathname === `${path}/stills`) {
          if (failStillUpload)
            return Response.json({ error: "Owned image store unavailable" }, { status: 503 });
          const form = await request.formData();
          const file = form.get("frame") as File;
          return Response.json(
            await media.still(
              f.changeID,
              f.userID,
              JSON.parse(String(form.get("context"))),
              new Uint8Array(await file.arrayBuffer()),
              String(form.get("id")),
            ),
          );
        }
        const pathToFile =
          url.pathname === "/"
            ? resolve(frontend, "visual-review.html")
            : resolve(frontend, url.pathname.slice(1));
        if (!pathToFile.startsWith(frontend + sep)) return new Response(null, { status: 404 });
        const file = Bun.file(pathToFile);
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
      } catch (cause) {
        return Response.json(
          { error: cause instanceof CommandError ? cause.message : String(cause) },
          { status: 409 },
        );
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  functions = await compiledFactoryEndpoint(
    {
      origin: base,
      services: {
        review: {
          ...service,
          async get(userID, changeID) {
            if (failReview) throw new CommandError("unavailable", "Owned review read unavailable");
            const value = await service.get(userID, changeID);
            return visualReviewSchema.parse(
              !unavailable
                ? value
                : {
                    ...value,
                    recording:
                      unavailable === "missing"
                        ? null
                        : {
                            ...value.recording,
                            state: unavailable,
                            reason: "Owned video unavailable",
                          },
                  },
            );
          },
          async create(userID, changeID, input) {
            saves++;
            const result = await service.create(userID, changeID, input);
            if (loseFeedbackResponse) {
              loseFeedbackResponse = false;
              throw new CommandError("unavailable", "Owned response loss after save");
            }
            return result;
          },
          async update(userID, changeID, input) {
            const delay = delayedReply;
            const result = await service.update(userID, changeID, input);
            if (delay) {
              delay.saved.resolve();
              await delay.release.promise;
            }
            return result;
          },
          async send(userID, changeID, input) {
            revisionRequests++;
            const result = await service.send(userID, changeID, input);
            if (loseRevisionResponse) {
              loseRevisionResponse = false;
              throw new CommandError("unavailable", "Owned revision response loss");
            }
            return result;
          },
        },
      } as FactoryServices,
      session: async () => ({ user: { id: f.userID } }),
      maintenance: async () => false,
      requireFresh: async () => {},
    },
    resolve(buildDirectory, "server/start-server.js"),
  );
  // No tab-capture or auto-consent launch flags.
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];
  let failedPage: import("@playwright/test").Page | undefined;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      Object.assign(window, { screenSharingRequests: 0 });
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: async () => {
          (window as unknown as { screenSharingRequests: number }).screenSharingRequests++;
          throw new Error("Screen sharing must never be requested by review comments");
        },
      });
    });
    const page = await context.newPage();
    failedPage = page;
    await page.addInitScript(() => {
      Object.assign(window, { reviewMessages: [] });
      window.addEventListener("message", (event) => {
        if (event.data?.type?.startsWith("factory-review-"))
          (window as unknown as { reviewMessages: unknown[] }).reviewMessages.push({
            ...event.data,
            image: event.data.image ? "[image]" : null,
          });
      });
    });
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    const captureContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: resolve(directory, "fixture-video"), size: { width: 1280, height: 720 } },
    });
    const capturePage = await captureContext.newPage();
    const recordedVideo = fixtureValue(capturePage.video(), "capturePage.video()");
    await capturePage.setContent(
      '<style>body{font:20px sans-serif;padding:40px;background:#f7f5ef}input,button{font:inherit;padding:8px}</style><h1>Delivery form · QA browser fixture</h1><label>Project title <input value="Retained draft"></label><button>Save draft</button><p>Scripted fixture, not a model QA run.</p>',
    );
    await capturePage.getByRole("button", { name: "Save draft" }).click();
    await capturePage.getByRole("textbox").fill("");
    await capturePage.getByRole("textbox").fill("Retained draft");
    await capturePage.waitForTimeout(2500);
    await capturePage.close();
    await captureContext.close();
    const video = await Bun.file(await recordedVideo.path()).bytes();
    const durationMs = await page.evaluate(
      async (bytes) => {
        const player = document.createElement("video");
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/webm" }));
        try {
          const loaded = new Promise<void>((resolve, reject) => {
            player.onloadedmetadata = () => resolve();
            player.onerror = () => reject(new Error("Owned video unavailable"));
          });
          player.src = url;
          await loaded;
          if (!Number.isFinite(player.duration)) throw new Error("Owned video is not seekable");
          return Math.round(player.duration * 1000);
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      [...video],
    );
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,kind,commit_sha,runtime_attempt_id,state)
      VALUES(${recordingID},${f.changeID},${f.reviewID},'recording',${f.commit},${f.attemptID},'intended')`;
    await media.publish(recordingID, video, durationMs);
    for (const [id, title, category] of [
      ["save", "Save a draft", "normal"],
      ["empty", "Empty title", "error"],
    ])
      await f.database
        .client`INSERT INTO factory.review_scenario(review_id,id,title,category,criterion,expected,status,ended_at,media_started_ms,observed)
        VALUES(${f.reviewID},${fixtureValue(id, "id")},${fixtureValue(title, "title")},${fixtureValue(category, "category")},1,'Form state is retained','passed',now(),${id === "save" ? 0 : 1000},'Draft remains visible after the interaction.')`;
    await f.database.client`INSERT INTO factory.review_scenario(
      review_id,id,title,category,criterion,expected,status,ended_at,observed)
      VALUES(${f.reviewID},'untimed','Missing recording position','boundary',1,
        'This case has no seek position.','passed',now(),'The browser observation remains available.')`;
    await page.goto(
      `${base}/?change=${f.changeID}&user=${f.userID}&attempt=${f.attemptID}&project=${f.projectID}`,
    );
    const panel = () =>
      page
        .getByRole("region", { name: "Visual review", exact: true })
        .filter({ has: page.locator(".review-recording") });
    const app = () => page.frameLocator('iframe[title="Factory Preview"]');
    const popup = () => page.locator(".preview-comment-popover");
    const ticketTab = () => page.getByRole("tab", { name: "Validation review", exact: true });
    const _previewTab = () => page.getByRole("tab", { name: "Development · Form", exact: true });
    const initial = page.getByRole("region", { name: "Visual review", exact: true });
    await visible(
      initial.getByText("Review is unavailable. Reload review before adding feedback.", {
        exact: true,
      }),
    ).toBeVisible();
    await visible(initial.getByText("Loading review…", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(directory, "review-load-error.png"), fullPage: true });
    failReview = false;
    await initial.getByRole("button", { name: "Reload review", exact: true }).click();
    await visible(panel().getByRole("button", { name: "Comment", exact: true })).toBeEnabled();
    expect(
      await panel()
        .locator("video")
        .evaluate((node) => (node as HTMLVideoElement).controls),
    ).toBe(false);
    await visible(panel().getByRole("slider", { name: "QA timeline" })).toBeEnabled();
    await panel().getByRole("button", { name: "Next scenario", exact: true }).click();
    await visible
      .poll(() =>
        panel()
          .locator("video")
          .evaluate((node) => (node as HTMLVideoElement).currentTime),
      )
      .toBeCloseTo(1, 1);
    expect(
      await panel()
        .locator("video")
        .evaluate((node) => (node as HTMLVideoElement).paused),
    ).toBe(true);
    await panel().getByRole("button", { name: "Previous scenario", exact: true }).click();
    await visible
      .poll(() =>
        panel()
          .locator("video")
          .evaluate((node) => (node as HTMLVideoElement).currentTime),
      )
      .toBeCloseTo(0, 1);
    const timeline = panel().getByRole("slider", { name: "QA timeline" });
    await timeline.focus();
    await timeline.press("ArrowRight");
    await visible
      .poll(() =>
        panel()
          .locator("video")
          .evaluate((node) => (node as HTMLVideoElement).currentTime),
      )
      .toBeCloseTo(0.1, 1);
    await panel().getByRole("button", { name: "Play QA recording", exact: true }).click();
    await visible
      .poll(() =>
        panel()
          .locator("video")
          .evaluate((node) => (node as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThan(1.1);
    await visible(panel().getByRole("button", { name: /Empty title/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await panel()
        .locator("video")
        .evaluate((node) => (node as HTMLVideoElement).paused),
    ).toBe(false);
    await panel().getByRole("button", { name: "Pause QA recording", exact: true }).click();
    const beforeUntimed = await panel()
      .locator("video")
      .evaluate((node) => (node as HTMLVideoElement).currentTime);
    await panel()
      .getByRole("button", { name: /Missing recording position/ })
      .click();
    await visible(
      panel()
        .locator(".review-scenario-summary")
        .getByText("This case has no seek position.", { exact: true }),
    ).toBeVisible();
    await panel().getByRole("button", { name: "Reload review" }).click();
    await visible(
      panel().getByRole("button", { name: /Missing recording position/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await panel()
        .locator("video")
        .evaluate((node) => (node as HTMLVideoElement).currentTime),
    ).toBeCloseTo(beforeUntimed, 1);
    await panel().getByRole("button", { name: "Full screen", exact: true }).click();
    await visible.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.screenshot({ path: resolve(directory, "player-fullscreen.png") });
    await panel().getByRole("button", { name: "Exit full screen", exact: true }).click();
    await visible.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await panel()
      .getByRole("button", { name: /Empty title/ })
      .click();
    await page.waitForTimeout(100);
    await panel().getByRole("button", { name: "Full screen", exact: true }).click();
    await panel().getByRole("button", { name: "Comment", exact: true }).click();
    await visible.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await panel()
      .getByRole("button", { name: "Choose a point on the paused QA frame" })
      .click({ position: { x: 100, y: 80 } });
    await panel()
      .getByRole("textbox", { name: "Review comment" })
      .fill("The empty title should keep my draft and show an error.");
    await page.screenshot({ path: resolve(directory, "video-comment.png"), fullPage: true });
    await panel().getByRole("combobox", { name: "Feedback type" }).selectOption("thread");
    await panel().getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible(
      panel().getByText("1 open Thread blocks Delivery", { exact: true }),
    ).toBeVisible();
    await visible(panel().getByRole("button", { name: "Open QA feedback 1" })).toBeVisible();
    await visible(panel().getByRole("checkbox")).toHaveCount(0);
    await visible(panel().getByRole("button", { name: /QA feedback 1 at/ })).toBeVisible();
    await panel().getByRole("button", { name: "Full screen", exact: true }).click();
    await panel()
      .getByRole("button", { name: /QA feedback 1 at/ })
      .click();
    await visible.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await visible(panel().getByRole("article", { name: /thread by/ })).toBeFocused();
    expect(saves).toBe(1);
    const thread = () =>
      panel()
        .getByRole("article", { name: /thread by/ })
        .first();
    await thread().getByRole("button", { name: "View saved QA frame", exact: true }).click();
    await visible(thread().getByRole("dialog", { name: "Saved feedback context" })).toBeVisible();
    await visible(thread().getByRole("img", { name: "Original review frame" })).toBeVisible();
    await thread().getByRole("button", { name: "Close context", exact: true }).press("Escape");
    await visible(thread().getByRole("dialog", { name: "Saved feedback context" })).toHaveCount(0);
    await visible(
      thread().getByRole("button", { name: "View saved QA frame", exact: true }),
    ).toBeFocused();
    await thread().getByRole("button", { name: "View saved QA frame", exact: true }).click();
    await thread()
      .getByRole("button", { name: /^Video ·/ })
      .click();
    await visible(thread().getByRole("dialog", { name: "Saved feedback context" })).toHaveCount(0);
    await visible(thread().locator("details")).toHaveCount(0);
    await thread().getByText("Reply", { exact: true }).click();
    await thread().getByRole("textbox").fill("Checked again after reload.");
    await thread().getByRole("button", { name: "Add reply" }).click();
    await visible(thread().getByText("Checked again after reload.")).toBeVisible();
    await thread().getByText("Reply", { exact: true }).click();
    await thread().getByRole("textbox").fill("Unsent reply retained across refresh");
    await panel().getByRole("button", { name: "Reload review" }).click();
    await visible(thread().getByRole("textbox")).toHaveValue(
      "Unsent reply retained across refresh",
    );
    delayedReply = { saved: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    await thread().getByRole("button", { name: "Add reply", exact: true }).click();
    await delayedReply.saved.promise;
    await thread()
      .getByRole("textbox")
      .fill("A newer unsent reply must survive the acknowledgement.");
    delayedReply.release.resolve();
    delayedReply = undefined;
    await visible(
      thread().getByText("Unsent reply retained across refresh", { exact: true }),
    ).toBeVisible();
    await visible(thread().getByRole("textbox")).toHaveValue(
      "A newer unsent reply must survive the acknowledgement.",
    );
    await visible(thread().locator(".review-reply-list .review-message")).toHaveCount(2);
    await thread().getByRole("textbox").fill("");
    await panel().getByRole("button", { name: "Add feedback", exact: true }).click();
    await visible(panel().getByRole("combobox", { name: "Feedback type" })).toHaveValue("comment");
    await panel()
      .getByRole("textbox", { name: "Review comment" })
      .fill("The whole flow needs fewer steps.");
    await panel().getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible(panel().getByText("The whole flow needs fewer steps.")).toBeVisible();
    await page.screenshot({ path: resolve(directory, "desktop.png"), fullPage: true });
    const position = await panel()
      .locator("video")
      .evaluate((element) => (element as HTMLVideoElement).currentTime);
    await panel().getByRole("button", { name: "Open Live Preview" }).click();
    expect(errors).toEqual([]);
    await visible(page.locator('iframe[title="Factory Preview"]')).toBeVisible({
      timeout: 5_000,
    });
    await app().getByRole("textbox").fill("Unsaved live input");
    await page.screenshot({ path: resolve(directory, "preview-clean.png"), fullPage: true });
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await app().getByRole("textbox").click();
    await visible(popup().getByRole("textbox", { name: "Review comment" })).toBeVisible();
    await visible(
      popup().getByText("Reconstructed element context", { exact: true }),
    ).toBeVisible();
    await popup().getByText("Reconstructed element context", { exact: true }).click();
    await visible(
      popup().getByRole("img", { name: "DOM reconstruction of the selected element" }),
    ).toBeVisible();
    await popup()
      .getByRole("textbox", { name: "Review comment" })
      .fill("Keep this selected Preview element.");
    await popup().getByRole("combobox", { name: "Feedback type" }).selectOption("thread");
    await popup().getByRole("textbox", { name: "Review comment" }).press("Escape");
    await visible(popup()).toBeHidden();
    await page.getByRole("button", { name: "Continue feedback", exact: true }).click();
    await visible(popup().getByRole("textbox", { name: "Review comment" })).toBeFocused();
    await visible(popup().getByRole("textbox", { name: "Review comment" })).toHaveValue(
      "Keep this selected Preview element.",
    );
    await visible(popup().getByRole("combobox", { name: "Feedback type" })).toHaveValue("thread");
    await visible(popup().getByText("Project title field", { exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve(directory, "preview-continue-draft.png"),
      fullPage: true,
    });
    await popup().getByRole("combobox", { name: "Feedback type" }).selectOption("comment");
    await page.screenshot({ path: resolve(directory, "preview-comment.png"), fullPage: true });
    expect(await app().locator("body").getAttribute("data-clicks")).toBe("0");
    await ticketTab().click();
    await visible(panel().locator("video")).toBeVisible();
    await visible
      .poll(() =>
        panel()
          .locator("video")
          .evaluate((element) => (element as HTMLVideoElement).currentTime),
      )
      .toBeCloseTo(position, 1);
    await panel().getByRole("button", { name: "Open Live Preview" }).click();
    await visible(popup().getByRole("textbox", { name: "Review comment" })).toHaveValue(
      "Keep this selected Preview element.",
    );
    await visible(app().getByRole("textbox")).toHaveValue("Unsaved live input");
    await visible(page.getByRole("tab")).toHaveCount(2);
    await page.setViewportSize({ width: 430, height: 1000 });
    await page.screenshot({ path: resolve(directory, "preview-narrow.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    loseFeedbackResponse = true;
    await popup().getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible(popup().getByRole("alert")).toContainText("Owned response loss");
    await page.reload();
    await visible(panel().getByRole("button", { name: "Retry save" })).toBeVisible();
    await panel().getByRole("button", { name: "Retry save" }).click();
    await visible(panel().getByText("Saved. No agent work has started.")).toBeVisible();
    expect((await review.get(f.changeID, f.userID)).feedback).toHaveLength(3);
    expect(saves).toBe(4);
    const previewFeedback = fixtureValue(
      (await review.get(f.changeID, f.userID)).feedback.find(
        (item) => item.annotation?.source === "preview",
      ),
      '(await review.get(f.changeID, f.userID)).feedback.find( (item) => item.annotation?.source === "preview", )',
    );
    expect(previewFeedback.annotation).toMatchObject({
      source: "preview",
      attemptId: f.attemptID,
      representation: "dom-reconstruction",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel().getByRole("button", { name: "Open Live Preview" }).click();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await visible(app().getByRole("button", { name: /Open feedback/ })).toHaveCount(0);
    // The saved source is from a previous document; reloading never projects it on the current App.
    blockContextImage = true;
    await page.locator(".factory-desktop").evaluate((node) => {
      (node as HTMLElement).dataset["background"] = "the-harvesters";
    });
    await page.getByRole("button", { name: "Done commenting", exact: true }).click();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await app().getByRole("button", { name: "Save draft", exact: true }).click();
    await popup()
      .getByRole("textbox", { name: "Review comment" })
      .fill("Feedback survives a blocked context renderer.");
    await popup().getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible
      .poll(async () => (await review.get(f.changeID, f.userID)).feedback.length)
      .toBe(4);
    const withoutImage = fixtureValue(
      (await review.get(f.changeID, f.userID)).feedback.at(-1),
      "(await review.get(f.changeID, f.userID)).feedback.at(-1)",
    );
    expect(withoutImage.annotation).toMatchObject({
      source: "preview",
      representation: "unavailable",
    });
    expect(withoutImage.annotation?.mediaId).toBeUndefined();
    await visible(app().getByRole("button", { name: /Open feedback/ })).toHaveCount(1);
    expect(
      await app()
        .getByRole("button", { name: /Open feedback/ })
        .evaluate((node) => ({
          background: getComputedStyle(node).backgroundColor,
          font: getComputedStyle(node).fontFamily,
        })),
    ).toMatchObject({ background: "rgb(112, 85, 46)", font: expect.stringContaining("Inter") });
    await app().locator("div[data-factory-review][tabindex]").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await visible(popup().getByText("Feedback survives a blocked context renderer.")).toBeVisible();
    await visible(popup().getByRole("heading", { name: "Feedback", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await visible(popup().getByRole("button", { name: "Close feedback" })).toBeFocused();
    await page.keyboard.press("Escape");
    await visible(popup()).toBeHidden();
    await visible(app().getByRole("button", { name: /Open feedback/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await visible(popup().getByRole("heading", { name: "Feedback", exact: true })).toBeFocused();
    await page.screenshot({
      path: resolve(directory, "preview-thread.png"),
      fullPage: true,
      caret: "initial",
    });
    await popup().getByRole("button", { name: "Close feedback" }).click();
    await page.getByRole("button", { name: "Done commenting", exact: true }).click();
    await app().getByRole("textbox").fill("Changed live state");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await visible(app().getByRole("button", { name: /Open feedback/ })).toHaveCount(0);
    // A failed optional image upload must not prevent saving the actual feedback.
    blockContextImage = false;
    await page.getByRole("button", { name: "Done commenting", exact: true }).click();
    await app()
      .locator("body")
      .evaluate(() => location.reload());
    await app().getByRole("textbox").waitFor();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await app().getByRole("textbox").click();
    await visible(
      popup().getByText("Reconstructed element context", { exact: true }),
    ).toBeVisible();
    failStillUpload = true;
    await popup()
      .getByRole("textbox", { name: "Review comment" })
      .fill("Feedback survives an unavailable image store.");
    await popup().getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible
      .poll(async () => (await review.get(f.changeID, f.userID)).feedback.length)
      .toBe(5);
    failStillUpload = false;
    await page.getByRole("button", { name: "Feedback in Ticket" }).click();
    await visible(panel().getByText("Feedback survives an unavailable image store.")).toBeVisible();
    await thread().getByRole("button", { name: "Resolve Thread" }).click();
    await visible(panel().getByText("Resolved (1)", { exact: true })).toBeVisible();
    await panel().getByText("Resolved (1)", { exact: true }).click();
    await panel().getByRole("button", { name: "Reopen Thread" }).click();
    await visible(
      panel().getByText("1 open Thread blocks Delivery", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 430, height: 1000 });
    await page.screenshot({ path: resolve(directory, "narrow.png"), fullPage: true });
    failVideo = true;
    await panel()
      .locator("video")
      .evaluate((node) => {
        const player = node as HTMLVideoElement;
        const url = new URL(player.currentSrc);
        url.searchParams.set("owned-failure", crypto.randomUUID());
        player.src = url.href;
      });
    await visible(panel().getByRole("button", { name: "Retry video", exact: true })).toBeVisible();
    await panel()
      .getByRole("button", { name: "Retry video", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, "video-load-error.png"), fullPage: true });
    failVideo = false;
    await panel().getByRole("button", { name: "Retry video", exact: true }).click();
    await visible(panel().getByRole("button", { name: "Comment", exact: true })).toBeEnabled();
    for (const state of ["missing", "unavailable", "deleted"] as const) {
      unavailable = state;
      await panel().getByRole("button", { name: "Reload review" }).click();
      await visible(panel().locator("video")).toHaveCount(0);
      await panel()
        .getByRole("button", { name: /Empty title/ })
        .click();
      await visible(
        panel()
          .locator(".review-scenario-summary")
          .getByText("Draft remains visible after the interaction.", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: resolve(directory, `no-video-${state}.png`), fullPage: true });
    }
    blockBridge = true;
    await panel().getByRole("button", { name: "Open Live Preview" }).click();
    await app()
      .locator("body")
      .evaluate(() => location.reload());
    await app().getByRole("textbox").waitFor();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await visible(popup().getByRole("textbox", { name: "Review comment" })).toBeVisible();
    await popup()
      .getByRole("textbox", { name: "Review comment" })
      .fill("General feedback with App scripting blocked.");
    await popup().getByRole("button", { name: "Save feedback", exact: true }).click();
    await visible
      .poll(async () => (await review.get(f.changeID, f.userID)).feedback.length)
      .toBe(6);
    expect((await review.get(f.changeID, f.userID)).feedback.at(-1)?.annotation).toBeNull();
    await page.screenshot({ path: resolve(directory, "csp-fallback.png"), fullPage: true });
    expect(
      await page.evaluate(
        () => (window as unknown as { screenSharingRequests: number }).screenSharingRequests,
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
    blockBridge = false;
    await page.goto(
      `${base}/?change=${f.changeID}&user=${f.userID}&attempt=${f.attemptID}&project=${f.projectID}&unbound=1`,
    );
    await panel().getByRole("button", { name: "Open Live Preview" }).click();
    await visible(app().getByRole("textbox")).toBeVisible();
    await visible(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
    await visible(
      page.getByRole("button", { name: "Feedback in Ticket", exact: true }),
    ).toHaveCount(0);
    const [turns] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.agent_turn WHERE change_id=${f.changeID}`;
    expect(turns?.count).toBe(1);
    await ticketTab().click();
    await visible(panel().getByRole("checkbox")).toHaveCount(0);
    loseRevisionResponse = true;
    await panel()
      .getByRole("button", { name: /^Request revision · \d+ Threads?$/ })
      .click();
    await visible(panel().getByRole("alert")).toContainText("Owned revision response loss");
    await page.reload();
    await panel().getByRole("button", { name: "Retry correction request", exact: true }).click();
    await visible(
      panel().getByText("Revision requested. Threads stay open for your recheck."),
    ).toBeVisible();
    expect(revisionRequests).toBe(2);
    const [after] = await f.database.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM factory.agent_turn WHERE change_id=${f.changeID}`;
    expect(after?.count).toBe(2);
    await visible(
      panel().getByRole("button", { name: /^Request revision · \d+ Threads?$/ }),
    ).toHaveCount(0);
  } catch (cause) {
    if (failedPage) {
      await failedPage.screenshot({ path: resolve(directory, "failure.png") }).catch(() => {});
      await writeFile(
        resolve(directory, "failure.json"),
        JSON.stringify(
          {
            messages: await failedPage.evaluate(
              () => (window as unknown as { reviewMessages: unknown[] }).reviewMessages,
            ),
            frames: failedPage.frames().map((frame) => frame.url()),
            errors,
          },
          null,
          2,
        ),
      );
    }
    throw cause;
  } finally {
    await browser.close();
    server.stop(true);
    await f.dispose();
    await rm(buildDirectory, { recursive: true, force: true });
  }
}, 120_000);
