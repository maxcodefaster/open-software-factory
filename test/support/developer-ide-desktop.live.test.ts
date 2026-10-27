import { expect, test } from "bun:test";
import { callFactoryFunction, authenticatedBootstrap } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect as browserExpect, chromium, type Page, type Request } from "@playwright/test";
import { z } from "zod";
import {
  developerIDEViewSchema,
  sourceWorkspaceViewSchema,
} from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { proveDesktopRuntime } from "../fixtures/developer-ide-desktop-runtime";
import {
  editorFixtureNamespaces,
  finishedPrebuildNamespace,
  recordedEditorIdentity,
  removeEditorFixtureNamespaceInChild,
} from "../fixtures/editor-source-resources";
import { eventually } from "../fixtures/factory-process";
import { openProjectMenu } from "../fixtures/project-menu";
import { deleteFactoryProject } from "./factory-fixture";
import { slice20StartupTargetFailures } from "./runtime-startup";
import { fixtureValue } from "../fixtures/value";

const enabled = process.env["FACTORY_RUN_DEVELOPER_IDE_DESKTOP_PROOF"] === "1";
const runtimeEnabled = process.env["FACTORY_RUN_DEVELOPER_IDE_RUNTIME_PROOF"] === "1";
const performanceEnabled = process.env["FACTORY_CHECK_SLICE20_STARTUP_TARGETS"] === "1";
const base = "http://127.0.0.1:3000";
test.skipIf(!enabled)(
  "product desktop retains one real source-only IDE and optionally proves exact-runtime Terminal/Run/Preview",
  async () => {
    const proofID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/developer-ide-desktop", proofID);
    await mkdir(artifacts, { recursive: true });
    const stage = (name: string) =>
      writeFile(resolve(artifacts, "progress.json"), JSON.stringify({ stage: name }));
    const database = createDatabase();
    const beforeNamespaces = await editorFixtureNamespaces();
    await writeFile(
      resolve(artifacts, "initial-namespaces.json"),
      JSON.stringify(beforeNamespaces),
    );
    const projects = [crypto.randomUUID(), crypto.randomUUID()];
    const email = `desktop-editor-${proofID}@factory.invalid`;
    const password = "desktop-editor-password-not-a-secret";
    const ownedNamespaces = new Map<string, { ownerID: string; uid?: string }>();
    let userID = "";
    let developerCookie = "";
    let page: Page | undefined;
    let switchStart: number | undefined;
    const switchSteps: Array<{ step: string; elapsedMS: number }> = [];
    const requests = new Map<Request, { operation: string; started: number }>();
    const requestTimings: Array<{ operation: string; startedMS: number; durationMS: number }> = [];
    const switchStep = (step: string) => {
      if (switchStart !== undefined)
        switchSteps.push({ step, elapsedMS: Math.round(performance.now() - switchStart) });
    };
    const api = (path: string, cookie: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    const browser = await chromium.launch({ headless: true });
    try {
      if (performanceEnabled && !runtimeEnabled)
        throw new Error("Slice 20 startup targets require the real Terminal/Run/Preview proof");
      const signedIn = await api("/api/auth/sign-in/email", "", {
        email: process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local",
        password: process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password",
      });
      expect(signedIn.ok).toBe(true);
      const adminCookie = signedIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const admin = z
        .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
        .parse(await authenticatedBootstrap(base, { cookie: adminCookie })).session.user.id;
      const user = await serverCall(
        callFactoryFunction(
          base,
          "createAccount",
          [
            {
              name: "Desktop editor proof",
              email,
              password,
            },
          ],
          { cookie: adminCookie },
        ),
      );
      userID = z.object({ id: z.uuid() }).parse(user).id;
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({ proofID, userID, projects }),
      );
      for (const [index, projectID] of projects.entries()) {
        await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`desktop-editor-${proofID}-${index}`},${`Editor proof ${index + 1}`},${`file://${resolve(".factory/runtime-fixture-repository")}`},'main','.devcontainer/devcontainer.json',${admin})`;
        expect(
          (
            await callFactoryFunction(
              base,
              "saveProjectMember",
              [
                projectID,
                {
                  email,
                  role: "developer",
                },
              ],
              { cookie: adminCookie },
            )
          ).ok,
        ).toBe(true);
      }
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
      context.setDefaultTimeout(15_000);
      page = await context.newPage();
      // Capture operation names only, never grants, cookies, bodies or query strings.
      page.on("request", (request) => {
        if (switchStart === undefined || requestTimings.length >= 160) return;
        const path = new URL(request.url()).pathname;
        const source = path.match(/\/source\/(stat|list|read|events)$/)?.[1];
        const api = path.startsWith("/api/")
          ? path
              .split("/")
              .filter((part) => !/^[0-9a-f-]{36}$/.test(part))
              .join("/")
          : undefined;
        const operation = source ? `source:${source}` : api;
        if (operation)
          requests.set(request, {
            operation,
            started: performance.now(),
          });
      });
      page.on("requestfinished", (request) => {
        const timing = requests.get(request);
        requests.delete(request);
        if (!timing || switchStart === undefined || requestTimings.length >= 160) return;
        requestTimings.push({
          operation: timing.operation,
          startedMS: Math.round(timing.started - switchStart),
          durationMS: Math.round(performance.now() - timing.started),
        });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await browserExpect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
      developerCookie = (await context.cookies(base))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const selectProject = async (index: number) => {
        if (!page) throw new Error("Owned desktop missing");
        await openProjectMenu(page);
        await page
          .getByRole("button")
          .filter({ hasText: `desktop-editor-${proofID}-${index}` })
          .click();
        await browserExpect(page.getByRole("region", { name: "Ticket board" })).toContainText(
          `Editor proof ${index + 1}`,
        );
      };
      await selectProject(0);
      const projectA = projects[0];
      const projectB = projects[1];
      if (!projectA || !projectB) throw new Error("Missing owned Projects");
      const opened = performance.now();
      switchStart = opened;
      await stage("opening-ide");
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      const iframe = page.locator('iframe[title="Factory IDE"]');
      const frame = page.frameLocator('iframe[title="Factory IDE"]');
      const sourceNode = (workspaceID: string, path: string) =>
        frame.locator(`#files [id="factory-workspace://${workspaceID}/${path}"]`);
      // Collect genuinely cold readiness even when it misses the performance
      // target; result timings, not this diagnostic bound, decide acceptance.
      await browserExpect(iframe).toHaveCount(1, { timeout: 150_000 });
      await browserExpect(frame.locator("#files").getByText("src", { exact: true })).toBeVisible({
        timeout: 150_000,
      });
      const explorerMS = Math.round(performance.now() - opened);
      const workspaceA = await iframe.getAttribute("data-workspace-id");
      if (!workspaceA) throw new Error("Desktop did not select canonical source");
      await frame.locator("#files").getByText("src", { exact: true }).click();
      await frame.locator("#files").getByText("version.txt", { exact: true }).dblclick();
      const editor = frame.locator(".monaco-editor:visible");
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceA}/src/version.txt`,
      );
      await browserExpect(editor.locator(".view-lines")).toContainText("one");
      const visibleSourceMS = Math.round(performance.now() - opened);
      const sourceLifecycle = await database.client<Array<{ createdAt: Date; readyAt: Date }>>`
        SELECT create_intended_at AS "createdAt",updated_at AS "readyAt"
        FROM factory.workspace_source WHERE workspace_id=${workspaceA} AND state='ready'`;
      await writeFile(
        resolve(artifacts, "source-timings.json"),
        JSON.stringify({
          explorerMS,
          visibleSourceMS,
          sourceLifecycle: sourceLifecycle.map((row) => ({ ...row })),
          requestTimings: [...requestTimings],
        }),
      );
      switchStart = undefined;
      requests.clear();
      requestTimings.length = 0;
      await stage("source-visible");
      const input = editor.locator("[role='textbox']:not([aria-hidden='true'])");
      const mac = await frame.locator("body").evaluate(() => navigator.platform.startsWith("Mac"));
      await input.focus();
      await input.press(mac ? "Meta+ArrowDown" : "Control+End");
      await input.pressSequentially(`desktop-dirty-${proofID}`);
      const documentID = await frame.locator("body").evaluate(() => performance.timeOrigin);
      await page.screenshot({ path: resolve(artifacts, "desktop-dirty.png") });
      await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
      await browserExpect(iframe).toHaveCount(1);
      await browserExpect(iframe).toBeHidden();
      await browserExpect(page.getByRole("button", { name: "IDE", exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      await browserExpect(iframe).toBeVisible();
      await browserExpect(editor.locator(".view-lines")).toContainText(`desktop-dirty-${proofID}`);
      expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
      await selectProject(1);
      const preparedWorkspaceID = personalWorkspaceIdentity(projectB, userID).workspaceID;
      await stage("preparing-b");
      const prepared = await eventually(
        async () => {
          // Reading only: the selected-Project effect must admit preparation itself.
          const response = await callFactoryFunction(
            base,
            "getWorkspaceSource",
            [preparedWorkspaceID],
            { cookie: developerCookie },
          );
          if (!response.ok && response.status === 404) return null;
          return serverCall(Promise.resolve(response));
        },
        (view) => view?.state === "ready",
        "Prepared Project source not ready",
        150_000,
      );
      if (!prepared) throw new Error("Selected Project did not prepare its source");
      await stage("switching-b");
      await browserExpect(iframe).toHaveCount(1);
      expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
      switchStart = performance.now();
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      switchStep("dock-click-complete");
      await browserExpect(iframe).toHaveAttribute("data-workspace-id", prepared.workspaceID);
      switchStep("workspace-acknowledged");
      await frame.locator("#files").getByText("src", { exact: true }).click();
      switchStep("directory-expanded");
      await frame.locator("#files").getByText("version.txt", { exact: true }).dblclick();
      switchStep("file-open-complete");
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${prepared.workspaceID}/src/version.txt`,
      );
      await browserExpect(editor.locator(".view-lines")).toContainText("one");
      switchStep("source-editor-visible");
      const switchMS = Math.round(performance.now() - switchStart);
      await writeFile(
        resolve(artifacts, "switch-timings.json"),
        JSON.stringify({ switchMS, switchSteps, requestTimings }),
      );
      switchStart = undefined;
      requests.clear();
      await selectProject(0);
      await stage("returning-a");
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      await browserExpect(iframe).toHaveAttribute("data-workspace-id", workspaceA);
      // Identical file names in the former root are not the selected source.
      // Wait for the exact immutable node, not a row whose position may change.
      if (!(await sourceNode(workspaceA, "src/version.txt").isVisible()))
        await sourceNode(workspaceA, "src").getByText("src", { exact: true }).click();
      await sourceNode(workspaceA, "src/version.txt")
        .getByText("version.txt", { exact: true })
        .dblclick();
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceA}/src/version.txt`,
      );
      await browserExpect(editor.locator(".view-lines")).toContainText(`desktop-dirty-${proofID}`);
      expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
      await page.screenshot({ path: resolve(artifacts, "desktop-restored.png") });
      await page.setViewportSize({ width: 900, height: 760 });
      await page.screenshot({ path: resolve(artifacts, "desktop-narrow.png") });
      expect(errors).toEqual([]);
      expect(
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id IN ${database.client(projects)}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id IN ${database.client(projects)}`,
      ).toHaveLength(0);
      const runtimeProof = runtimeEnabled
        ? await proveDesktopRuntime({
            page,
            projectID: projectA,
            workspaceID: workspaceA,
            proofID,
            artifacts,
            api: (path, body) => api(path, developerCookie, body),
            selectProject,
          })
        : undefined;
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id IN ${database.client(projects)}`,
      ).toHaveLength(0);
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          visibleSourceMS,
          switchMS,
          oneRetainedFrame: true,
          dirtyBuffersRetained: true,
          noComputeOrTurnsFromBrowsing: true,
          sourcePreparedByProjectSelection: true,
          runtimeProof,
        }),
      );
      // Keep the target unchanged, but collect the independent runtime journey too.
      if (performanceEnabled) {
        if (!runtimeProof) throw new Error("Executable Terminal measurements are missing");
        expect(
          slice20StartupTargetFailures({
            loadedSourceMS: visibleSourceMS,
            executableTerminalMS: runtimeProof.terminalMS,
            restartedTerminalMS: runtimeProof.restartedTerminalMS,
          }),
        ).toEqual([]);
      }
      expect(switchMS).toBeLessThan(3000);
    } catch (cause) {
      await writeFile(
        resolve(artifacts, "failure.json"),
        JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }),
      );
      await page?.screenshot({ path: resolve(artifacts, "failure.png") }).catch(() => {});
      throw cause;
    } finally {
      await stage("closing-browser");
      await browser.close();
      await stage("stopping-source");
      try {
        const workspacesInDatabase = await database.client<
          Array<{ id: string; namespace: string; uid: string | null }>
        >`SELECT workspace.id,workspace.kubernetes_namespace AS namespace,source.namespace_uid AS uid FROM factory.development_workspace workspace LEFT JOIN factory.workspace_source source ON source.workspace_id=workspace.id WHERE workspace.project_id IN ${database.client(projects)} AND workspace.owner_user_id=${userID || null}`;
        for (const workspace of workspacesInDatabase) {
          ownedNamespaces.set(workspace.namespace, {
            ownerID: workspace.id,
            ...(workspace.uid ? { uid: workspace.uid } : {}),
          });
          const running = await database.client<
            Array<{ id: string }>
          >`SELECT id FROM factory.runtime_attempt WHERE workspace_id=${workspace.id} AND state NOT IN ('stopped','failed')`;
          for (const attempt of running) {
            expect(
              (
                await callFactoryFunction(
                  base,
                  "stopRuntimeAttempt",
                  [attempt.id],
                  { cookie: developerCookie, origin: base, "content-type": "application/json" },
                  AbortSignal.timeout(15_000),
                )
              ).ok,
            ).toBe(true);
            await eventually(
              async () =>
                (
                  await database.client<
                    Array<{ state: string }>
                  >`SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id}`
                )[0]?.state,
              (state) => state === "stopped",
              "Owned compute Stop incomplete",
              90_000,
            );
          }
          expect(
            await callFactoryFunction(base, "stopWorkspaceSource", [workspace.id], {
              cookie: developerCookie,
            }),
          ).toMatchObject({ ok: true });
          await eventually(
            async () =>
              sourceWorkspaceViewSchema.parse(
                await serverCall(
                  callFactoryFunction(base, "getWorkspaceSource", [workspace.id], {
                    cookie: developerCookie,
                  }),
                ),
              ),
            (view) => view.state === "stopped",
            "Owned source Stop incomplete",
            40_000,
          );
        }
        if (userID && developerCookie) {
          await stage("stopping-editor");
          const [editorOwnership] = await database.client<
            Array<{ uid: string | null }>
          >`SELECT namespace_uid AS uid FROM factory.developer_ide WHERE user_id=${userID}`;
          if (editorOwnership)
            ownedNamespaces.set(
              fixtureValue(
                await recordedEditorIdentity(database, userID),
                "(await recordedEditorIdentity(database, userID))",
              ).namespace,
              {
                ownerID: userID,
                ...(editorOwnership.uid ? { uid: editorOwnership.uid } : {}),
              },
            );
          if (editorOwnership) {
            await serverCall(
              callFactoryFunction(base, "stopDeveloperIDE", [], { cookie: developerCookie }),
            );
            await eventually(
              async () =>
                developerIDEViewSchema.parse(
                  await serverCall(
                    callFactoryFunction(base, "getDeveloperIDE", [], { cookie: developerCookie }),
                  ),
                ),
              (view) => view.state === "stopped",
              "Owned editor Stop incomplete",
              40_000,
            );
          }
        }
        for (const [name, ownership] of ownedNamespaces) {
          await stage(`removing-${name}`);
          await removeEditorFixtureNamespaceInChild(name, ownership);
        }
        for (const projectID of projects) await deleteFactoryProject(projectID);
        await stage("removing-account");
        if (userID)
          await database.client.begin(async (sql) => {
            await sql`DELETE FROM factory.developer_ide WHERE user_id=${userID} AND state='stopped'`;
            await sql`DELETE FROM factory.forge_account_intent WHERE user_id=${userID}`;
            await sql`DELETE FROM auth.account WHERE user_id=${userID}`;
            await sql`DELETE FROM auth."user" WHERE id=${userID} AND email=${email}`;
          });
        const remaining = await editorFixtureNamespaces();
        const missingNamespaces = beforeNamespaces.filter(
          (before) =>
            !remaining.some((after) => before.name === after.name && before.uid === after.uid),
        );
        // Automatic producers finish independently. Confirm exact persisted identity and
        // terminal outcome; never exempt a Workspace, unknown owner or replacement UID.
        const producers = await database.client<
          Array<{
            id: string;
            namespace: string;
            uid: string | null;
            kind: string | null;
            state: string;
            jobState: string;
          }>
        >`SELECT attempt.id,attempt.kubernetes_namespace AS namespace,attempt.kubernetes_namespace_uid AS uid,attempt.isolated_kind::text AS kind,attempt.state,preparation.state AS "jobState" FROM factory.runtime_attempt attempt JOIN factory.project_image_preparation preparation ON preparation.runtime_attempt_id=attempt.id WHERE attempt.isolated_kind='prebuild' AND attempt.state IN ('failed','stopped') AND preparation.state IN ('failed','succeeded')`;
        const completedBackgroundPrebuilds = missingNamespaces.filter((namespace) =>
          producers.some((producer) => finishedPrebuildNamespace(namespace, producer)),
        );
        const changedNamespaces = missingNamespaces.filter(
          (namespace) => !completedBackgroundPrebuilds.includes(namespace),
        );
        await writeFile(
          resolve(artifacts, "cleanup.json"),
          JSON.stringify({
            userID,
            projects,
            ownedNamespacesRemoved: true,
            unrelatedNamespacesUnchanged: changedNamespaces.length === 0,
            completedBackgroundPrebuilds,
            changedNamespaces,
          }),
        );
        expect(changedNamespaces).toEqual([]);
      } finally {
        await database.client.end({ timeout: 2 });
      }
    }
  },
  runtimeEnabled ? 720_000 : 360_000,
);
