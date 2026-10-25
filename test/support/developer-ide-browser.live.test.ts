import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect as browserExpect, chromium, type Page } from "@playwright/test";
import { z } from "zod";
import {
  developerIDEViewSchema,
  sourceWorkspaceViewSchema,
} from "../../apps/factory/src/api-contracts";
import { developerIDEOrigin } from "../../apps/factory/src/developer-ide-origin";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { publishedRuntimeArtifacts, runtimeArtifactsSchema } from "../../scripts/factory/artifacts";
import {
  editorFixtureKubectl,
  editorFixtureNamespaces as namespaces,
  recordedEditorIdentity,
  removeStoppedEditorSourceNamespace,
} from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { callFactoryFunction } from "../fixtures/server-functions";

const enabled = process.env["FACTORY_RUN_DEVELOPER_IDE_BROWSER_PROOF"] === "1";
const proofTimeoutMS = 420_000;
const podObservation = z.object({
  metadata: z.object({ uid: z.string(), labels: z.record(z.string(), z.string()) }),
  status: z.object({
    phase: z.string(),
    conditions: z
      .array(
        z.object({
          type: z.string(),
          status: z.string(),
          reason: z.string().optional(),
          message: z.string().optional(),
        }),
      )
      .optional(),
    containerStatuses: z
      .array(
        z.object({
          name: z.string(),
          ready: z.boolean(),
          restartCount: z.number(),
          state: z.object({
            waiting: z.object({ reason: z.string().optional() }).optional(),
            terminated: z
              .object({ reason: z.string().optional(), exitCode: z.number() })
              .optional(),
          }),
        }),
      )
      .optional(),
  }),
});

async function observeOwnedPod(namespace: string, name: string, uid: string, ownerID: string) {
  try {
    const pod = podObservation.parse(
      JSON.parse(await editorFixtureKubectl(["get", "pod", name, "-n", namespace, "-o", "json"])),
    );
    return pod.metadata.uid === uid && pod.metadata.labels["factory.dev/runtime-owner"] === ownerID
      ? pod.status
      : "identity-mismatch";
  } catch {
    return "unavailable";
  }
}

test.skipIf(!enabled)(
  "authenticated independent Theia reads canonical source, retains dirty Workspace buffers and revokes access without execution",
  async () => {
    // Share the existing proof window instead of abandoning a healthy Pending
    // editor at 120s. Leave time for assertions and exact owned teardown.
    const preparationDeadline = Date.now() + proofTimeoutMS - 90_000;
    const remainingPreparationMS = () => Math.max(1, preparationDeadline - Date.now());
    const proofID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/developer-ide-browser", proofID);
    await mkdir(artifacts, { recursive: true });
    const published = await publishedRuntimeArtifacts(resolve(".factory"));
    if (!published) throw new Error("Publish the exact runtime artifacts before the IDE proof");
    const images = runtimeArtifactsSchema.parse(published);
    const fixture = await factoryProcess(undefined, {
      FACTORY_HOST: "0.0.0.0",
      FACTORY_DEVELOPER_IDE_IMAGE:
        process.env["FACTORY_TEST_DEVELOPER_IDE_IMAGE"] ?? images["developer-ide"],
      FACTORY_WORKSPACE_FILES_IMAGE: images["workspace-files"],
    });
    const database = fixture.connect();
    const kubernetes = createKubernetesClient();
    const beforeNamespaces = await namespaces();
    const projects = [crypto.randomUUID(), crypto.randomUUID()];
    const sources: Array<{ projectID: string; workspaceID: string }> = [];
    const ownedNamespaces = new Map<string, { ownerID: string; uid?: string }>();
    const browser = await chromium.launch({ headless: true });
    let page: Page | undefined;
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    const networkErrors: Array<{ path: string; status?: number; error?: string }> = [];
    const requests: Array<{ path: string; status?: number }> = [];
    const requestPath = (value: string) => {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    };
    let userID = "";
    let cleanupConfirmed = false;
    let adminCookie = "";
    let developerCookie = "";
    const email = `editor-browser-${proofID}@factory.invalid`;
    const password = "editor-browser-password-not-a-secret";
    const api = (path: string, cookie: string, body?: unknown) =>
      fetch(`${fixture.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    try {
      await fixture.start();
      adminCookie = await fixture.signIn();
      const createdUser = await serverCall(
        callFactoryFunction(
          fixture.base,
          "createAccount",
          [
            {
              name: "Editor browser Developer",
              email,
              password,
            },
          ],
          { cookie: adminCookie },
        ),
      );
      userID = z.object({ id: z.uuid() }).parse(createdUser).id;
      for (const projectID of projects) {
        await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`editor-browser-${projectID}`},'Editor browser proof',${`file://${resolve(".factory/runtime-fixture-repository")}`},'main','.devcontainer/devcontainer.json',${userID})`;
        expect(
          (
            await callFactoryFunction(
              fixture.base,
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
      const signedIn = await api("/api/auth/sign-in/email", "", { email, password });
      expect(signedIn.ok).toBe(true);
      developerCookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const projectID = projects[0];
      if (!projectID) throw new Error("Missing owned Project");
      expect(
        (
          await callFactoryFunction(fixture.base, "ensureDeveloperIDE", [projectID], {
            cookie: developerCookie,
          })
        ).ok,
      ).toBe(true);
      const editorIdentity = await recordedEditorIdentity(database, userID);
      if (!editorIdentity) throw new Error("Missing recorded editor intent");
      ownedNamespaces.set(editorIdentity.namespace, { ownerID: userID });
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({
          proofID,
          factoryID: fixture.id,
          factoryOrigin: fixture.base,
          userID,
          projects,
          sources,
          namespaces: [...ownedNamespaces],
        }),
      );
      for (const projectID of projects) {
        const source = sourceWorkspaceViewSchema.parse(
          await serverCall(
            callFactoryFunction(fixture.base, "ensurePersonalSource", [projectID], {
              cookie: developerCookie,
            }),
          ),
        );
        sources.push({ projectID, workspaceID: source.workspaceID });
        const [workspace] = await database.client<
          Array<{ namespace: string }>
        >`SELECT kubernetes_namespace AS namespace FROM factory.development_workspace WHERE id=${source.workspaceID}`;
        if (!workspace) throw new Error("Missing owned source intent");
        ownedNamespaces.set(workspace.namespace, { ownerID: source.workspaceID });
        await writeFile(
          resolve(artifacts, "intent.json"),
          JSON.stringify({
            proofID,
            factoryID: fixture.id,
            factoryOrigin: fixture.base,
            userID,
            projects,
            sources,
            namespaces: [...ownedNamespaces],
          }),
        );
      }
      await Promise.all([
        eventually(
          async () => {
            const view = developerIDEViewSchema.parse(
              await serverCall(
                callFactoryFunction(fixture.base, "getDeveloperIDE", [], {
                  cookie: developerCookie,
                }),
              ),
            );
            if (view.state === "failed") throw new Error(`Editor failed: ${view.failure}`);
            return view;
          },
          (view) => view.state === "ready",
          "Editor not ready",
          remainingPreparationMS(),
        ),
        ...sources.map((source) =>
          eventually(
            async () => {
              const view = sourceWorkspaceViewSchema.parse(
                await serverCall(
                  callFactoryFunction(fixture.base, "getWorkspaceSource", [source.workspaceID], {
                    cookie: developerCookie,
                  }),
                ),
              );
              if (view.state === "failed")
                throw new Error(`Canonical source failed: ${view.failure}`);
              return view;
            },
            (view) => view.state === "ready",
            "Canonical source not ready",
            remainingPreparationMS(),
          ),
        ),
      ]);
      for (const [name, ownership] of ownedNamespaces) {
        const current = await kubernetes.getNamespace(name);
        if (!current) throw new Error("Owned resource missing");
        ownership.uid = current.uid;
      }
      const [a, b] = sources;
      if (!a || !b) throw new Error("Source fixtures missing");
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
      context.setDefaultTimeout(10_000);
      await context.addCookies(
        developerCookie.split("; ").map((cookie) => {
          const separator = cookie.indexOf("=");
          return {
            name: cookie.slice(0, separator),
            value: cookie.slice(separator + 1),
            url: fixture.base,
            httpOnly: true,
          };
        }),
      );
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (entry) => {
        if (entry.type() === "error")
          consoleErrors.push(
            entry
              .text()
              .replace(/https?:\/\/[^\s)]+/g, (value) => {
                try {
                  const url = new URL(value);
                  return `${url.origin}${url.pathname}`;
                } catch {
                  return "<url>";
                }
              })
              .slice(0, 1000),
          );
      });
      page.on("response", (response) => {
        requests.push({ path: requestPath(response.url()), status: response.status() });
        if (response.status() >= 400)
          networkErrors.push({ path: requestPath(response.url()), status: response.status() });
      });
      page.on("request", (request) => requests.push({ path: requestPath(request.url()) }));
      page.on("requestfailed", (request) =>
        networkErrors.push({
          path: requestPath(request.url()),
          error: request.failure()?.errorText ?? "Request failed",
        }),
      );
      // A fulfilled synthetic navigation has no loopback address classification in Chromium.
      // Establish the real Factory origin before inserting this minimal editing fixture.
      await page.goto(`${fixture.base}/health/ready`);
      const visibleStarted = performance.now();
      const ownedEditorOrigin = developerIDEOrigin(fixture.base, userID, 1);
      // Explicit fault injection belongs only to this owned proof. The Pod and
      // epoch stay unchanged while its initial document waits for readiness.
      await database.client`UPDATE factory.developer_ide SET state='preparing' WHERE user_id=${userID} AND service_epoch=1 AND state='ready'`;
      await page.setContent(
        `<!doctype html><button id="a" onclick="pick('${a.workspaceID}')">A</button><button id="b" onclick="pick('${b.workspaceID}')">B</button><iframe title="Factory IDE" style="position:absolute;inset:40px 0 0;width:100%;height:calc(100% - 40px);border:0" src="/api/developer-ide/access?embed=1"></iframe><script>const editorOrigin=${JSON.stringify(ownedEditorOrigin)};function pick(workspaceID){document.querySelector('iframe').contentWindow.postMessage({type:'factory:select-workspace',workspaceID},editorOrigin)}window.addEventListener('message',event=>{if(event.source===document.querySelector('iframe').contentWindow&&event.origin===editorOrigin&&event.data?.type==='factory:ide-ready')pick('${a.workspaceID}')})</script>`,
      );
      const frame = page.frameLocator('iframe[title="Factory IDE"]');
      await browserExpect(frame.getByRole("status")).toHaveText("Reconnecting to your editor…");
      await page.screenshot({ path: resolve(artifacts, "initial-editor-reconnecting.png") });
      await database.client`UPDATE factory.developer_ide SET state='ready' WHERE user_id=${userID} AND service_epoch=1 AND state='preparing'`;
      await browserExpect(frame.locator("#files").getByText("src", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const visibleEditorMS = Math.round(performance.now() - visibleStarted);
      await frame.locator("#files").getByText("src", { exact: true }).click();
      await frame.locator("#files").getByText("version.txt", { exact: true }).dblclick();
      const editor = frame.locator(".monaco-editor:visible");
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${a.workspaceID}/src/version.txt`,
      );
      const input = editor.locator("[role='textbox']:not([aria-hidden='true'])");
      await input.focus();
      const mac = await frame.locator("body").evaluate(() => navigator.platform.startsWith("Mac"));
      await input.press(mac ? "Meta+ArrowDown" : "Control+End");
      await input.pressSequentially(`human-${proofID}`);
      const documentID = await frame.locator("body").evaluate(() => performance.timeOrigin);
      await database.client`UPDATE factory.developer_ide SET state='preparing' WHERE user_id=${userID} AND service_epoch=1 AND state='ready'`;
      expect(
        await frame.locator("body").evaluate(
          async () =>
            (
              await fetch(new URL("__factory/context", new URL("./", window.location.href)), {
                credentials: "same-origin",
              })
            ).status,
        ),
      ).toBe(200);
      await browserExpect(editor.locator(".view-lines")).toContainText(`human-${proofID}`);
      expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
      await database.client`UPDATE factory.developer_ide SET state='ready' WHERE user_id=${userID} AND service_epoch=1 AND state='preparing'`;
      await page.screenshot({ path: resolve(artifacts, "source-a-dirty.png") });
      const switched = performance.now();
      await page.locator("#b").click();
      await browserExpect(
        frame.locator(`[id="factory-workspace://${b.workspaceID}/src"]`),
      ).toBeVisible();
      await frame.locator(`[id="factory-workspace://${b.workspaceID}/src"]`).click();
      await frame.locator("#files").getByText("version.txt", { exact: true }).dblclick();
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${b.workspaceID}/src/version.txt`,
      );
      const switchMS = Math.round(performance.now() - switched);
      expect(switchMS).toBeLessThan(3000);
      expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
      await page.locator("#a").click();
      await browserExpect(
        frame.locator(`[id="factory-workspace://${a.workspaceID}/src"]`),
      ).toBeVisible();
      if (!(await frame.locator("#files").getByText("version.txt", { exact: true }).isVisible()))
        await frame.locator(`[id="factory-workspace://${a.workspaceID}/src"]`).click();
      await frame.locator("#files").getByText("version.txt", { exact: true }).dblclick();
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${a.workspaceID}/src/version.txt`,
      );
      await browserExpect(editor.locator(".view-lines")).toContainText(`human-${proofID}`);
      await editor.locator("[role='textbox']:not([aria-hidden='true'])").press("ControlOrMeta+s");
      await eventually(
        async () =>
          z.object({ content: z.string() }).parse(
            await (
              await api(`/api/workspaces/${a.workspaceID}/source/read`, developerCookie, {
                path: "src/version.txt",
              })
            ).json(),
          ).content,
        (value) => Buffer.from(value, "base64").toString().includes(`human-${proofID}`),
        "Real source save missing",
      );
      const bFile = await api(`/api/workspaces/${b.workspaceID}/source/read`, developerCookie, {
        path: "src/version.txt",
      });
      expect(
        Buffer.from(
          z.object({ content: z.string() }).parse(await bFile.json()).content,
          "base64",
        ).toString(),
      ).not.toContain(`human-${proofID}`);
      await page.screenshot({ path: resolve(artifacts, "source-a-saved.png") });
      await page.setViewportSize({ width: 900, height: 760 });
      await page.screenshot({ path: resolve(artifacts, "source-narrow.png") });
      expect(errors).toEqual([]);
      for (const relation of ["runtime_attempt", "change", "agent_turn"])
        expect(await database.client.unsafe(`SELECT 1 FROM factory.${relation}`)).toHaveLength(0);
      for (const projectID of projects)
        expect(
          (
            await callFactoryFunction(
              fixture.base,
              "saveProjectMember",
              [
                projectID,
                {
                  email,
                  role: "product-contributor",
                },
              ],
              { cookie: adminCookie },
            )
          ).ok,
        ).toBe(true);
      await browserExpect
        .poll(async () =>
          frame.locator("body").evaluate(
            async () =>
              (
                await fetch(new URL("__factory/context", new URL("./", window.location.href)), {
                  credentials: "same-origin",
                })
              ).status,
          ),
        )
        .toBe(401);
      expect(
        await callFactoryFunction(fixture.base, "getWorkspaceSource", [a.workspaceID], {
          cookie: developerCookie,
        }),
      ).toMatchObject({ ok: false, status: 403 });
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          visibleEditorMS,
          switchMS,
          documentID,
          noExecution: true,
          dirtyBuffersRetained: true,
          initialReadinessRecovery: true,
          dirtyBufferRetainedThroughReadinessLoss: true,
          savedOnlyOriginalWorkspace: true,
          revoked: true,
        }),
      );
    } catch (cause) {
      const sourceState = await database.client<
        Array<{
          workspaceID: string;
          namespace: string;
          state: string;
          failure: string | null;
          podUID: string | null;
        }>
      >`SELECT source.workspace_id AS "workspaceID",workspace.kubernetes_namespace AS namespace,
        source.state,source.failure,source.pod_uid AS "podUID"
        FROM factory.workspace_source source JOIN factory.development_workspace workspace
        ON workspace.id=source.workspace_id WHERE workspace.project_id=ANY(${projects}::uuid[])`;
      const sourcePods = await Promise.all(
        sourceState.map(async (source) => {
          if (!source.podUID) return { ...source, observed: null };
          return {
            ...source,
            observed: await observeOwnedPod(
              source.namespace,
              "source-1",
              source.podUID,
              source.workspaceID,
            ),
          };
        }),
      );
      await writeFile(resolve(artifacts, "source-failure-state.json"), JSON.stringify(sourcePods));
      const [editor] = await database.client<
        Array<{
          state: string;
          failure: string | null;
          podUID: string | null;
        }>
      >`SELECT state,failure,pod_uid AS "podUID" FROM factory.developer_ide WHERE user_id=${userID}`;
      const identity = userID ? await recordedEditorIdentity(database, userID) : undefined;
      await writeFile(
        resolve(artifacts, "editor-failure-state.json"),
        JSON.stringify({
          editor,
          observed:
            editor?.podUID && identity
              ? await observeOwnedPod(identity.namespace, identity.podName, editor.podUID, userID)
              : null,
        }),
      );
      const frames = await Promise.all(
        (page?.frames() ?? []).map(async (frame) => ({
          path: requestPath(frame.url()),
          document: await frame
            .evaluate(() => ({
              ready: document.readyState,
              shell: Boolean(document.getElementById("theia-app-shell")),
              scripts: Array.from(document.scripts, (script) =>
                script.src ? new URL(script.src).pathname : "inline",
              ),
            }))
            .catch(() => null),
        })),
      );
      await writeFile(
        resolve(artifacts, "diagnostics.json"),
        JSON.stringify({ errors, consoleErrors, networkErrors, requests, frames }),
      );
      await page?.screenshot({ path: resolve(artifacts, "failure.png") }).catch(() => {});
      throw cause;
    } finally {
      await browser.close();
      try {
        for (const projectID of projects)
          if (adminCookie && userID)
            await serverCall(
              callFactoryFunction(
                fixture.base,
                "saveProjectMember",
                [
                  projectID,
                  {
                    email,
                    role: "developer",
                  },
                ],
                { cookie: adminCookie },
              ),
            );
        for (const source of sources) {
          expect(
            await callFactoryFunction(fixture.base, "stopWorkspaceSource", [source.workspaceID], {
              cookie: developerCookie,
            }),
          ).toMatchObject({ ok: true });
          await eventually(
            async () =>
              sourceWorkspaceViewSchema.parse(
                await serverCall(
                  callFactoryFunction(fixture.base, "getWorkspaceSource", [source.workspaceID], {
                    cookie: developerCookie,
                  }),
                ),
              ),
            (view) => view.state === "stopped",
            "Owned source Stop incomplete",
            40_000,
          );
        }
        if (userID) {
          const editorIdentity = await recordedEditorIdentity(database, userID);
          if (editorIdentity) ownedNamespaces.set(editorIdentity.namespace, { ownerID: userID });
          await serverCall(
            callFactoryFunction(fixture.base, "stopDeveloperIDE", [], { cookie: developerCookie }),
          );
          await eventually(
            async () =>
              developerIDEViewSchema.parse(
                await serverCall(
                  callFactoryFunction(fixture.base, "getDeveloperIDE", [], {
                    cookie: developerCookie,
                  }),
                ),
              ),
            (view) => view.state === "stopped",
            "Owned editor Stop incomplete",
            40_000,
          );
        }
        await fixture.shutdown();
        for (const [name, ownership] of ownedNamespaces) {
          const current = await kubernetes.getNamespace(name);
          if (!current) continue;
          await removeStoppedEditorSourceNamespace(name, { ...ownership, uid: current.uid });
        }
        const remaining = await namespaces();
        expect(
          beforeNamespaces.every((before) =>
            remaining.some((after) => before.name === after.name && before.uid === after.uid),
          ),
        ).toBe(true);
        await writeFile(
          resolve(artifacts, "cleanup.json"),
          JSON.stringify({
            ownedNamespacesRemoved: true,
            unrelatedNamespacesUnchanged: true,
            namespaces: [...ownedNamespaces],
          }),
        );
        cleanupConfirmed = true;
      } finally {
        await database.client.end({ timeout: 2 });
        if (cleanupConfirmed) await fixture.dispose();
        else {
          await writeFile(
            resolve(artifacts, "cleanup-unconfirmed.json"),
            JSON.stringify({
              proofID,
              factoryID: fixture.id,
              factoryOrigin: fixture.base,
              userID,
              projects,
              sources,
              namespaces: [...ownedNamespaces],
            }),
          );
          await fixture.pause();
        }
      }
    }
  },
  proofTimeoutMS,
);
