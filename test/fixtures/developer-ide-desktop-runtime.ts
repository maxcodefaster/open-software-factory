import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { z } from "zod";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { starterImagesSchema } from "../../scripts/factory/starter-images";
import { createDatabase } from "../../packages/db/src/client";
import { runtimeCacheObservation } from "./runtime-cache-observation";
import { browserFunction } from "./server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

export async function startEditorCompute(page: Page) {
  const frame = page.frameLocator('iframe[title="Factory IDE"]');
  await expect(frame.locator("#theia-app-shell")).toBeVisible({ timeout: 60_000 });
  await frame.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  const start = frame.getByRole("button", { name: "Start compute", exact: true });
  const takeOver = frame.getByRole("button", { name: "Take over editing", exact: true });
  await expect
    .poll(
      async () =>
        ((await start.count()) > 0 && (await start.isEnabled())) || (await takeOver.isVisible()),
    )
    .toBe(true);
  if (await takeOver.isVisible()) await takeOver.click();
  await expect(start).toBeEnabled();
  // The independently granted IDE owns this native protocol. Opening source
  // alone must not dispatch a central Factory compute command.
  const pending = page.waitForResponse(
    (response) =>
      /\/__factory\/workspaces\/[0-9a-f-]{36}\/runtime\/ensure$/.test(
        new URL(response.url()).pathname,
      ) && response.request().method() === "POST",
  );
  await start.click();
  const response = await pending;
  expect(response.status()).toBe(202);
  return z.object({ workspaceID: z.uuid(), attemptID: z.uuid() }).parse(await response.json());
}

export async function proveDesktopRuntime(input: {
  page: Page;
  projectID: string;
  workspaceID: string;
  proofID: string;
  artifacts: string;
  api: (path: string, body?: unknown) => Promise<Response>;
  selectProject: (index: number) => Promise<void>;
}) {
  const { page, projectID, workspaceID, proofID, artifacts, api, selectProject } = input;
  const projectImages = starterImagesSchema.parse(
    JSON.parse(await readFile(".factory/starter-images.json", "utf8")),
  );
  await page.setViewportSize({ width: 1440, height: 950 });
  const frame = page.frameLocator('iframe[title="Factory IDE"]');
  const iframe = page.locator('iframe[title="Factory IDE"]');
  const terminalTab = frame.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" });
  const terminal = frame.locator(".factory-terminal-widget");
  const host = terminal.locator(".factory-terminal-host:not([hidden])");
  const runTab = frame.locator(".lm-TabBar-tab").filter({ hasText: "Run" });
  const run = frame.locator(".factory-runtime-widget");
  const documentID = await frame.locator("body").evaluate(() => performance.timeOrigin);
  await terminalTab.click();
  await expect(terminal).toContainText("Workspace compute is stopped");
  await expect(host).toHaveCount(0);
  const computeStart = performance.now();
  const admittedAt = new Date().toISOString();
  await terminal.getByRole("button", { name: "Start compute", exact: true }).click();
  await expect(frame.locator(".monaco-editor:visible")).toBeVisible();
  await expect(host).toHaveAttribute("data-connection-state", "connected", { timeout: 240_000 });
  const connectedMS = Math.round(performance.now() - computeStart);
  const list = z
    .object({ attempts: z.array(runtimeAttemptSchema) })
    .parse(await serverCall(browserFunction(page, "getRuntimeAttempts", [projectID])));
  const attempt = list.attempts.find(
    (value) => value.workspaceId === workspaceID && value.state === "ready",
  );
  if (!attempt) throw new Error("Desktop Terminal has no exact ready attempt");
  const command = async (text: string, output: string) => {
    await host.locator(".xterm").click({ force: true });
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await expect(host.locator(".xterm-rows")).toContainText(output, { timeout: 30_000 });
  };
  await command("printf 'canonical-pty='; pwd", "canonical-pty=/workspace/project");
  const terminalMS = Math.round(performance.now() - computeStart);
  const observe = async (attemptID: string, startedAt: string, label: string) => {
    const database = createDatabase();
    try {
      const [identity] = await database.client<
        Array<{
          namespace: string;
          podName: string;
          podUID: string;
          image: string;
          node: string;
        }>
      >`SELECT attempt.kubernetes_namespace AS namespace,attempt.kubernetes_pod_name AS "podName",attempt.kubernetes_uid AS "podUID",artifact.runtime_host_image AS image,source.storage_node AS node
        FROM factory.runtime_attempt attempt JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
        JOIN factory.workspace_source source ON source.workspace_id=attempt.workspace_id
        WHERE attempt.id=${attemptID} AND attempt.project_id=${projectID} AND attempt.workspace_id=${workspaceID} AND attempt.state='ready'`;
      if (!identity?.podUID || !identity.node)
        throw new Error("Missing owned ready runtime observation");
      const caches = await runtimeCacheObservation({
        ...identity,
        attemptID,
        runtimeHostImage: identity.image,
        startedAt,
        projectImages: [projectImages.development, projectImages.support],
      });
      await mkdir(artifacts, { recursive: true });
      await writeFile(resolve(artifacts, `${label}-caches.json`), JSON.stringify(caches));
    } finally {
      await database.client.end({ timeout: 2 });
    }
  };
  await writeFile(
    resolve(artifacts, "terminal-timings.json"),
    JSON.stringify({ connectedMS, terminalMS }),
  );
  await observe(attempt.id, admittedAt, "initial");
  await command(
    "export FACTORY_TERMINAL_PROOF=original; printf 'attempt=%s\\n' \"$FACTORY_TERMINAL_PROOF\"",
    "attempt=original",
  );
  await command(
    "npm install --ignore-scripts --no-audit --no-fund && printf 'package-install=%s\\n' complete",
    "package-install=complete",
  );
  expect(
    (await api(`/api/workspaces/${workspaceID}/source/read`, { path: "package-lock.json" })).ok,
  ).toBe(true);
  await command(
    'node -e \'console.log("foreground-"+"ready");setInterval(()=>{},1000)\'',
    "foreground-ready",
  );
  await page.keyboard.press("Control+c");
  await command("printf 'after-interrupt=%s\\n' alive", "after-interrupt=alive");
  await command(
    'node -e \'console.log("foreground-"+"restarted");setInterval(()=>{},1000)\'',
    "foreground-restarted",
  );
  await page.keyboard.press("Control+c");
  await command("printf 'after-restart=%s\\n' alive", "after-restart=alive");
  await page.screenshot({ path: resolve(artifacts, "independent-terminal.png") });
  await selectProject(1);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await terminalTab.click();
  await expect(terminal).toContainText("Workspace compute is stopped");
  await expect(host).toHaveCount(0);
  await selectProject(0);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(iframe).toHaveAttribute("data-workspace-id", workspaceID);
  await terminalTab.click();
  await expect(host).toHaveAttribute("data-connection-state", "connected");
  await command(
    "printf 'retained-original=%s\\n' \"$FACTORY_TERMINAL_PROOF\"",
    "retained-original=original",
  );
  expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
  await runTab.click();
  const worker = run.getByRole("button").filter({ hasText: "Worker monitor" });
  await expect(worker).toContainText("Running", { timeout: 20_000 });
  await worker.click();
  await run.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(worker).toContainText("Stopped");
  await run.getByRole("button", { name: "Start", exact: true }).click();
  await expect(worker).toContainText("Running");
  await run.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(worker).toContainText("Running");
  await run.getByRole("button").filter({ hasText: "Web" }).click();
  await run.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Factory Preview"]');
  await expect(preview.getByRole("heading", { name: "Runtime fixture ready" })).toBeVisible();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const editor = frame.locator(".monaco-editor:visible");
  const text = editor.locator("[role='textbox']:not([aria-hidden='true'])");
  await text.focus();
  const mac = await frame.locator("body").evaluate(() => navigator.platform.startsWith("Mac"));
  await text.press(mac ? "Meta+s" : "Control+s");
  await expect
    .poll(async () => {
      const value = z
        .object({ content: z.string() })
        .parse(
          await (
            await api(`/api/workspaces/${workspaceID}/source/read`, { path: "src/version.txt" })
          ).json(),
        );
      return Buffer.from(value.content, "base64").toString();
    })
    .toContain(`desktop-dirty-${proofID}`);
  await page.getByRole("tab").filter({ hasText: "Development · Web" }).click();
  await expect(preview.locator("#version")).toContainText(`desktop-dirty-${proofID}`);
  await page.screenshot({ path: resolve(artifacts, "source-save-hmr-preview.png") });
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await runTab.click();
  await page.screenshot({ path: resolve(artifacts, "independent-run.png") });
  await serverCall(browserFunction(page, "stopRuntimeAttempt", [attempt.id]));
  await expect
    .poll(
      async () => {
        const list = z
          .object({ attempts: z.array(runtimeAttemptSchema) })
          .parse(await serverCall(browserFunction(page, "getRuntimeAttempts", [projectID])));
        return list.attempts.find((value) => value.id === attempt.id)?.state;
      },
      { timeout: 90_000 },
    )
    .toBe("stopped");
  await terminalTab.click();
  await expect(terminal.getByRole("button", { name: "Start compute", exact: true })).toBeVisible({
    timeout: 40_000,
  });
  await expect(editor.locator(".view-lines")).toContainText(`desktop-dirty-${proofID}`);
  const restarted = performance.now();
  const restartedAt = new Date().toISOString();
  await terminal.getByRole("button", { name: "Start compute", exact: true }).click();
  await expect(host).toHaveAttribute("data-connection-state", "connected", { timeout: 150_000 });
  const restartedConnectedMS = Math.round(performance.now() - restarted);
  await command(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX expansion runs in the real PTY, not JavaScript.
    "printf 'new-attempt=%s\\n' \"${FACTORY_TERMINAL_PROOF:-fresh}\"",
    "new-attempt=fresh",
  );
  const restartedTerminalMS = Math.round(performance.now() - restarted);
  await writeFile(
    resolve(artifacts, "restart-timings.json"),
    JSON.stringify({ restartedConnectedMS, restartedTerminalMS, previousAttemptStopped: true }),
  );
  await command(
    "test -f package-lock.json && printf 'retained-data=%s\\n' yes",
    "retained-data=yes",
  );
  const secondList = z
    .object({ attempts: z.array(runtimeAttemptSchema) })
    .parse(await serverCall(browserFunction(page, "getRuntimeAttempts", [projectID])));
  const second = secondList.attempts.find(
    (value) => value.workspaceId === workspaceID && value.state === "ready",
  );
  if (!second || second.id === attempt.id)
    throw new Error("Stopped terminal was silently rebound instead of creating a new attempt");
  await observe(second.id, restartedAt, "retained");
  expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
  return {
    terminalMS,
    connectedMS,
    restartedTerminalMS,
    restartedConnectedMS,
    exactAttempts: [attempt.id, second.id],
    originalPTYRetainedAcrossSwitch: true,
    sourceSaveHMR: true,
    runProcessControl: true,
    packageInstallAndCtrlC: true,
  };
}
