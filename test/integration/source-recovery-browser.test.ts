import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { developerIDEOrigin } from "../../apps/factory/src/developer-ide-origin";
import { chromium, expect as visible } from "@playwright/test";
import { factoryProcess } from "../fixtures/factory-process";

test("failed file access can be explicitly restarted without discarding the editor or starting compute", async () => {
  const fixture = await factoryProcess(undefined, { FACTORY_HOST: "0.0.0.0" });
  const database = fixture.connect();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : {}),
  });
  const projectID = crypto.randomUUID(),
    workspaceID = crypto.randomUUID();
  const slug = `source-recovery-${projectID.slice(0, 8)}`;
  const calls: string[] = [];
  let state: "failed" | "stop-intended" | "stopped" | "ready" = "ready";
  let epoch = 1,
    stopReads = 0,
    editorLoads = 0,
    editorEnsures = 0,
    computeStarts = 0;
  let page: import("@playwright/test").Page | undefined;
  const frontend = resolve(
    ".factory/test-results/source-recovery-browser",
    `frontend-${crypto.randomUUID()}`,
  );
  try {
    const build = Bun.spawn(
      [
        "node",
        resolve("node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        resolve("apps/factory/vite.config.ts"),
        "--outDir",
        frontend,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const buildError = await new Response(build.stderr).text();
    if (await build.exited)
      throw new Error(`Owned frontend build failed: ${buildError.slice(-500)}`);
    await fixture.startPlanningCache();
    await fixture.start();
    const cookie = await fixture.signIn();
    const [user] = await database.client<Array<{ id: string }>>`SELECT id FROM auth."user"
      WHERE email=${`owned-${fixture.id}@factory.local`}`;
    if (!user) throw Error("Owned source recovery actor missing");
    const userID = String(user.id);
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Source recovery fixture','https://example.invalid/owned','main','.devcontainer/devcontainer.json',${userID})`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // Chromium treats the intercepted entry document as public-network content.
    // Permit only this owned fixture origin to reach its loopback planning cache.
    await context.grantPermissions(["local-network-access"], { origin: fixture.base });
    await context.addCookies(
      cookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: fixture.base,
      })),
    );
    page = await context.newPage();
    // Test the current frontend without replacing assets served by a retained
    // developer installation or depending on an older host build.
    await page.route(`${fixture.base}/`, (route) =>
      route.fulfill({ path: resolve(frontend, "index.html") }),
    );
    await page.route(`${fixture.base}/assets/**`, (route) => {
      const file = resolve(frontend, new URL(route.request().url()).pathname.slice(1));
      if (!file.startsWith(frontend + sep)) throw new Error("Fixture asset path escaped its build");
      return route.fulfill({ path: file });
    });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/(?:runtime|personal-workspace\/ensure|implement)$/.test(new URL(request.url()).pathname)
      )
        computeStarts++;
    });
    const source = () => ({
      workspaceID,
      serviceID: `source-${workspaceID.slice(0, 8)}-${epoch}`,
      epoch,
      state,
      failure:
        state === "failed" ? "Source preparation failed. Stop and retry source access." : null,
    });
    await page.route(`**/api/projects/${projectID}/source-workspace/ensure`, (route) =>
      route.fulfill({ json: source() }),
    );
    await page.route(`**/api/projects/${projectID}/developer-ide/ensure`, (route) => {
      editorEnsures++;
      return route.fulfill({
        json: { serviceID: "owned-editor", epoch: 1, state: "ready", failure: null },
      });
    });
    await page.route("**/api/developer-ide", (route) =>
      route.fulfill({
        json: { serviceID: "owned-editor", epoch: 1, state: "ready", failure: null },
      }),
    );
    const editorOrigin = developerIDEOrigin(fixture.base, userID, 1);
    const editorURL = `${editorOrigin}/owned-source-editor`;
    await page.route("**/api/developer-ide/access?*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }),
    );
    await page.route(editorURL, (route) => {
      editorLoads++;
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><textarea aria-label="Unsaved editor">retained source draft</textarea><script>
          parent.postMessage({type:"factory:ide-ready"},${JSON.stringify(fixture.base)});
          addEventListener("message",event=>{
            if(event.origin===${JSON.stringify(fixture.base)}&&event.data.type==="factory:select-workspace")
              parent.postMessage({type:"factory:workspace-selected",workspaceID:event.data.workspaceID},event.origin);
          });
          </script>`,
      });
    });
    await page.route(`**/api/workspaces/${workspaceID}/source{,/**}`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const operation = path.split("/").at(-1);
      if (operation === "stop") {
        calls.push("stop");
        state = "stop-intended";
        stopReads = 0;
        return route.fulfill({ status: 202, body: "" });
      }
      if (operation === "ensure") {
        calls.push(`ensure:${state}`);
        if (state === "failed") return route.fulfill({ json: source() });
        if (state !== "stopped") throw Error("Restart must first confirm Stop");
        state = "ready";
        epoch++;
        return route.fulfill({ json: source() });
      }
      if (state === "stop-intended") {
        stopReads++;
        if (stopReads > 1) state = "stopped";
      }
      calls.push(`read:${state}`);
      return route.fulfill({ json: source() });
    });
    await page.goto(fixture.base);
    await page.getByRole("button", { name: "Open project menu", exact: true }).click();
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    const frame = page.locator('iframe[title="Factory IDE"]');
    const draft = page.frameLocator('iframe[title="Factory IDE"]').getByLabel("Unsaved editor");
    // Supply the admitted editor origin without starting a Theia Pod. Redirect
    // targets bypass Playwright route interception, so bind this controlled
    // document directly. The real parent origin/source checks remain in use.
    const embedded = await (await frame.elementHandle())?.contentFrame();
    if (!embedded) throw Error("Owned editor frame missing");
    await embedded.goto(editorURL);
    await visible(draft).toHaveValue("retained source draft");
    await draft.evaluate(
      (_element, origin) => parent.postMessage({ type: "factory:ide-ready" }, origin),
      fixture.base,
    );
    await visible(frame).toHaveAttribute("data-workspace-id", workspaceID);
    await draft.fill("keep this unsaved buffer through source recovery");
    state = "failed";
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    await visible(
      page.getByRole("button", {
        name: /^(Restart file access|Retry editor connection)$/,
      }),
    ).toBeVisible();
    await visible(
      page.getByRole("status").filter({ hasText: "Source preparation failed" }),
    ).toBeVisible();
    await mkdir(".factory/test-results/source-recovery-browser", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/source-recovery-browser/failed-desktop.png",
    });
    const ensuresBeforeRecovery = editorEnsures;
    await page.getByRole("button", { name: "Retry file access", exact: true }).click();
    await visible.poll(() => calls.includes("ensure:failed")).toBe(true);
    await visible(
      page.getByRole("button", { name: "Restart file access", exact: true }),
    ).toBeVisible();
    expect(state).toBe("failed");
    expect(epoch).toBe(1);
    expect(calls).not.toContain("stop");
    await page
      .getByRole("button", { name: /^(Restart file access|Retry editor connection)$/ })
      .dblclick();
    await visible.poll(() => state, { timeout: 3000 }).toBe("ready");
    await visible(frame).toHaveAttribute("data-workspace-id", workspaceID);
    await visible(draft).toHaveValue("keep this unsaved buffer through source recovery");
    expect(calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(calls).toContain("read:stop-intended");
    expect(calls).toContain("read:stopped");
    expect(calls.filter((call) => call.startsWith("ensure:"))).toEqual([
      "ensure:failed",
      "ensure:stopped",
    ]);
    expect(editorLoads).toBe(1);
    expect(editorEnsures).toBe(ensuresBeforeRecovery);
    expect(computeStarts).toBe(0);
    expect(epoch).toBe(2);
    expect(failures).toEqual([]);
    await page.screenshot({
      path: ".factory/test-results/source-recovery-browser/recovered-desktop.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    state = "failed";
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    const recovery = page.getByRole("button", { name: "Restart file access", exact: true });
    const failure = page.getByRole("status").filter({ hasText: "Source preparation failed" });
    await visible(recovery).toBeVisible();
    const buttonBox = await recovery.boundingBox(),
      errorBox = await failure.boundingBox();
    expect(buttonBox && errorBox).toBeTruthy();
    expect(buttonBox!.x).toBeGreaterThanOrEqual(0);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(390);
    expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(buttonBox!.y);
    await page.screenshot({
      path: ".factory/test-results/source-recovery-browser/failed-narrow.png",
    });
    await recovery.focus();
    await page.keyboard.press("Enter");
    await visible.poll(() => state, { timeout: 3000 }).toBe("ready");
    expect(epoch).toBe(3);
    expect(editorLoads).toBe(1);
    expect(editorEnsures).toBe(ensuresBeforeRecovery);
    expect(computeStarts).toBe(0);
    await visible(draft).toHaveValue("keep this unsaved buffer through source recovery");
    await page.screenshot({
      path: ".factory/test-results/source-recovery-browser/recovered-narrow.png",
    });
  } catch (cause) {
    if (page) {
      await mkdir(".factory/test-results/source-recovery-browser", { recursive: true });
      await page.screenshot({ path: ".factory/test-results/source-recovery-browser/failure.png" });
      await Bun.write(
        ".factory/test-results/source-recovery-browser/failure-ui.txt",
        await page.locator("body").innerText(),
      );
      await Bun.write(
        ".factory/test-results/source-recovery-browser/failure-frames.json",
        JSON.stringify(
          { frames: page.frames().map((frame) => frame.url()), editorLoads, calls, state },
          null,
          2,
        ),
      );
    }
    throw cause;
  } finally {
    try {
      await browser.close();
      await database.client.end({ timeout: 2 });
      await fixture.dispose();
    } finally {
      await rm(frontend, { recursive: true, force: true });
    }
  }
}, 90_000);
