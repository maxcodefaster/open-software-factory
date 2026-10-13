import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect as browserExpect, chromium, type Page } from "@playwright/test";
import { z } from "zod";
import {
  developerIDEViewSchema,
  sourceWorkspaceViewSchema,
} from "../../apps/factory/src/api-contracts";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { developerIDEIdentity } from "../../packages/workspace-domain/src/developer-ide";
import {
  editorFixtureNamespaces as namespaces,
  removeStoppedEditorSourceNamespace,
} from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";

const enabled = process.env["FACTORY_RUN_DEVELOPER_IDE_BROWSER_PROOF"] === "1";

test.skipIf(!enabled)(
  "authenticated independent Theia reads canonical source, retains dirty Workspace buffers and revokes access without execution",
  async () => {
    const proofID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/developer-ide-browser", proofID);
    await mkdir(artifacts, { recursive: true });
    const fixture = await factoryProcess(
      {
        runtimeHostImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
        forgejoToken: (await readFile(".factory/forgejo-token", "utf8")).trim(),
      },
      {
        FACTORY_DEVELOPER_IDE_IMAGE:
          process.env["FACTORY_TEST_DEVELOPER_IDE_IMAGE"] ??
          (await readFile(".factory/developer-ide-image", "utf8")).trim(),
        FACTORY_WORKSPACE_FILES_IMAGE: (
          await readFile(".factory/workspace-files-image", "utf8")
        ).trim(),
      },
    );
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
      const createdUser = await api("/api/admin/users", adminCookie, {
        name: "Editor browser Developer",
        email,
        password,
      });
      expect(createdUser.status).toBe(201);
      userID = z.object({ id: z.uuid() }).parse(await createdUser.json()).id;
      ownedNamespaces.set(developerIDEIdentity(userID, 1).namespace, { ownerID: userID });
      for (const projectID of projects) {
        await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`editor-browser-${projectID}`},'Editor browser proof',${`file://${resolve(".factory/runtime-fixture-repository")}`},'main','.devcontainer/devcontainer.json',${userID})`;
        expect(
          (
            await api(`/api/projects/${projectID}/members`, adminCookie, {
              email,
              role: "developer",
            })
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
        (await api(`/api/projects/${projectID}/developer-ide/ensure`, developerCookie, {})).ok,
      ).toBe(true);
      await eventually(
        async () =>
          developerIDEViewSchema.parse(
            await (await api("/api/developer-ide", developerCookie)).json(),
          ),
        (view) => view.state === "ready",
        "Editor not ready",
        120_000,
      );
      for (const projectID of projects) {
        const source = sourceWorkspaceViewSchema.parse(
          await (
            await api(`/api/projects/${projectID}/source-workspace/ensure`, developerCookie, {})
          ).json(),
        );
        sources.push({ projectID, workspaceID: source.workspaceID });
        const [workspace] = await database.client<
          Array<{ namespace: string }>
        >`SELECT kubernetes_namespace AS namespace FROM factory.development_workspace WHERE id=${source.workspaceID}`;
        if (!workspace) throw new Error("Missing owned source intent");
        ownedNamespaces.set(workspace.namespace, { ownerID: source.workspaceID });
        await writeFile(
          resolve(artifacts, "intent.json"),
          JSON.stringify({ proofID, userID, projects, sources, namespaces: [...ownedNamespaces] }),
        );
        await eventually(
          async () =>
            sourceWorkspaceViewSchema.parse(
              await (
                await api(`/api/workspaces/${source.workspaceID}/source`, developerCookie)
              ).json(),
            ),
          (view) => view.state === "ready",
          "Canonical source not ready",
          150_000,
        );
      }
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
      await page.goto(`${fixture.base}/api/session`);
      const visibleStarted = performance.now();
      await page.setContent(
        `<!doctype html><button id="a" onclick="pick('${a.workspaceID}')">A</button><button id="b" onclick="pick('${b.workspaceID}')">B</button><iframe title="Factory IDE" style="position:absolute;inset:40px 0 0;width:100%;height:calc(100% - 40px);border:0" src="/api/developer-ide/access?embed=1"></iframe><script>const editorOrigin='http://${userID.replaceAll("-", "")}.1.editor.runtime.localhost:${new URL(fixture.base).port}';function pick(workspaceID){document.querySelector('iframe').contentWindow.postMessage({type:'factory:select-workspace',workspaceID},editorOrigin)}window.addEventListener('message',event=>{if(event.source===document.querySelector('iframe').contentWindow&&event.origin===editorOrigin&&event.data?.type==='factory:ide-ready')pick('${a.workspaceID}')})</script>`,
      );
      const frame = page.frameLocator('iframe[title="Factory IDE"]');
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
            await api(`/api/projects/${projectID}/members`, adminCookie, {
              email,
              role: "product-contributor",
            })
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
      expect((await api(`/api/workspaces/${a.workspaceID}/source`, developerCookie)).status).toBe(
        403,
      );
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          visibleEditorMS,
          switchMS,
          documentID,
          noExecution: true,
          dirtyBuffersRetained: true,
          savedOnlyOriginalWorkspace: true,
          revoked: true,
        }),
      );
    } catch (cause) {
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
            await api(`/api/projects/${projectID}/members`, adminCookie, {
              email,
              role: "developer",
            });
        for (const source of sources) {
          expect(
            (await api(`/api/workspaces/${source.workspaceID}/source/stop`, developerCookie, {}))
              .status,
          ).toBe(202);
          await eventually(
            async () =>
              sourceWorkspaceViewSchema.parse(
                await (
                  await api(`/api/workspaces/${source.workspaceID}/source`, developerCookie)
                ).json(),
              ),
            (view) => view.state === "stopped",
            "Owned source Stop incomplete",
            40_000,
          );
        }
        if (userID) {
          await api("/api/developer-ide/stop", developerCookie, {});
          await eventually(
            async () =>
              developerIDEViewSchema.parse(
                await (await api("/api/developer-ide", developerCookie)).json(),
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
      } finally {
        await database.client.end({ timeout: 2 });
        await fixture.dispose();
      }
    }
  },
  420_000,
);
