import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect as visible } from "@playwright/test";
import { z } from "zod";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { localOpenBao } from "../../scripts/factory/openbao";
import { removeOwnedProjectSources } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { ownedRuntimeTerminal, runtimeAccessCookie } from "../fixtures/runtime-access";
import { starterDelivery } from "../fixtures/starter-delivery";
import { starterPreviewBrowser } from "../fixtures/starter-preview-browser";
import { starterSetupDesktop } from "../fixtures/starter-setup-desktop";

test.skipIf(process.env["FACTORY_RUN_STARTER_RUNTIME_PROOF"] !== "1")(
  "turnkey Starter creates through setup and runs real database authentication, source and PTY through Envbox",
  async () => {
    const retained = process.env["FACTORY_STARTER_RESUME"]
      ? z
          .object({
            id: z.uuid(),
            base: z.string(),
            directory: z.string().startsWith(`${tmpdir()}/factory-owned-starter-runtime-`),
            projectID: z.uuid(),
            setupID: z.uuid(),
            slug: z.string().regex(/^owned-starter-[a-f0-9]{8}$/),
          })
          .parse(JSON.parse(process.env["FACTORY_STARTER_RESUME"]))
      : undefined;
    const directory =
      retained?.directory ?? (await mkdtemp(join(tmpdir(), "factory-owned-starter-runtime-")));
    const bao = await localOpenBao(directory);
    const configuration = await bao.start();
    const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const factory = await factoryProcess(
      {
        runtimeHostImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
        forgejoToken: token,
      },
      {
        ...configuration,
        FACTORY_FORGEJO_ADMIN_TOKEN: (
          await readFile(".factory/forgejo-admin-token", "utf8")
        ).trim(),
      },
      retained,
    );
    const database = factory.connect();
    const browser = await chromium.launch({ headless: true });
    let projectID = retained?.projectID ?? "";
    let cookie = "";
    let setupID = retained?.setupID ?? "";
    let succeeded = false;
    let terminal: Awaited<ReturnType<typeof ownedRuntimeTerminal>> | undefined;
    const slug = retained?.slug ?? `owned-starter-${crypto.randomUUID().slice(0, 8)}`;
    const forge = createForgejoClient({ apiURL: "http://127.0.0.1:33030/api/v1/", token });
    const timings: Record<string, number> = {};
    async function api(path: string, method = "GET", body?: unknown) {
      const response = await fetch(factory.base + path, {
        method,
        headers: { cookie, origin: factory.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok)
        throw new Error(
          `Owned Starter ${path} failed with ${response.status}: ${JSON.stringify(await response.json()).slice(0, 500)}`,
        );
      const content = await response.text();
      return content ? JSON.parse(content) : null;
    }
    const attempts = () =>
      database.client<
        { id: string; state: string; failure: string | null }[]
      >`SELECT id,state,failure FROM factory.runtime_attempt WHERE project_id=${projectID}`;
    async function ready(id: string) {
      return eventually(
        async () => {
          const row = (await attempts()).find((row) => row.id === id);
          if (row?.state === "failed") throw new Error(row.failure ?? "Starter runtime failed");
          return row;
        },
        (row) => row?.state === "ready",
        "Starter runtime not ready",
        240_000,
      );
    }
    try {
      if (process.env["FACTORY_RUN_STARTER_DESKTOP_PROOF"] === "1")
        await factory.startPlanningCache();
      await factory.start();
      cookie = await factory.signIn();
      const started = performance.now();
      if (!retained) {
        const draft = await api("/api/project-setup", "POST");
        setupID = draft.id;
        const saved = await api("/api/project-setup", "PUT", {
          id: setupID,
          version: draft.version,
          name: "Turnkey Starter",
          slug,
          kind: "starter",
          sourceURL: "",
        });
        const created = await api("/api/project-setup/create", "POST", {
          id: setupID,
          version: saved.version,
          commandID: crypto.randomUUID(),
        });
        expect(created.state).toBe("created");
        projectID = created.projectID;
      }
      if (process.env["FACTORY_RUN_STARTER_DESKTOP_PROOF"] === "1")
        await starterSetupDesktop({ browser, base: factory.base, cookie, projectID });
      if (process.env["FACTORY_STARTER_RESTART_PREVIEW"] === "1") {
        if (!retained) throw new Error("Preview recovery requires the exact retained installation");
        const [preview] = await database.client<{ id: string; state: string }[]>`
          SELECT attempt.id,attempt.state FROM factory.staging_preview preview
          JOIN factory.runtime_attempt attempt ON attempt.id=preview.runtime_attempt_id
          WHERE preview.project_id=${projectID} AND attempt.project_id=${projectID}`;
        if (!preview || preview.state === "ready")
          throw new Error("Preview recovery requires an unavailable owned Main-Preview");
        expect(
          await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID} AND change_id IS NOT NULL`,
        ).toHaveLength(0);
        await api(`/api/runtime-attempts/${preview.id}/stop`, "POST", {});
        await eventually(
          async () => (await attempts()).find((row) => row.id === preview.id)?.state,
          (state) => state === "stopped",
          "Owned unavailable Preview did not Stop",
          150_000,
        );
        await api(`/api/projects/${projectID}/setup/retry`, "POST", { task: "main-preview" });
        console.log(
          JSON.stringify({ recoveredOwnedPreview: preview.id, operation: "Stop and setup retry" }),
        );
      }
      if (process.env["FACTORY_STARTER_DELIVERY_ONLY"] === "1") {
        await eventually(
          () => api(`/api/projects/${projectID}/setup`),
          (rows) =>
            ["protection", "development-secrets"].every((task) =>
              rows.some(
                (row: { task: string; state: string }) =>
                  row.task === task && row.state === "ready",
              ),
            ),
          "Starter delivery prerequisites not ready",
          60000,
        );
        const delivered = await starterDelivery({ database, projectID, api });
        if (!delivered.previewID) throw new Error("Delivered preview missing");
        await starterPreviewBrowser({
          browser,
          base: factory.base,
          cookie,
          previewID: delivered.previewID,
          heading: "Welcome home.",
          screenshot: ".factory/screenshots/project-setup/starter-delivered-home.png",
        });
        succeeded = true;
        return;
      }
      await eventually(
        () => api(`/api/projects/${projectID}/setup`),
        (rows) =>
          rows.some(
            (row: { task: string; state: string }) =>
              row.task === "main-preview" && row.state === "ready",
          ),
        "Starter setup preview did not become ready",
        300_000,
      );
      timings["initialPreviewMS"] = Math.round(performance.now() - started);
      const [preview] = await database.client<
        { id: string }[]
      >`SELECT runtime_attempt_id AS id FROM factory.staging_preview WHERE project_id=${projectID}`;
      if (!preview) throw new Error("Starter preview missing");
      const runtimeCookie = await runtimeAccessCookie(factory.base, cookie, preview.id, "app");
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const appOrigin = `http://${preview.id.replaceAll("-", "")}.app.runtime.localhost:${new URL(factory.base).port}`;
      const prefix = `/runtime/${preview.id}/app`;
      const clientResponse = await fetch(`${appOrigin}${prefix}/@vite/client`, {
        headers: { cookie: runtimeCookie },
        signal: AbortSignal.timeout(10_000),
      });
      expect(clientResponse.status).toBe(200);
      expect(await clientResponse.text()).toContain("WebSocket");
      await context.addCookies(
        runtimeCookie.split("; ").map((part) => ({
          name: part.slice(0, part.indexOf("=")),
          value: part.slice(part.indexOf("=") + 1),
          url: appOrigin,
        })),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      let hmrConnected = false;
      const hmrEvents: string[] = [];
      page.on("websocket", (socket) => {
        if (hmrEvents.length < 12) hmrEvents.push(`open ${new URL(socket.url()).pathname}`);
        socket.on("socketerror", (error) => {
          if (hmrEvents.length < 12) hmrEvents.push(`error ${String(error).slice(0, 200)}`);
        });
        socket.on("close", () => {
          if (hmrEvents.length < 12) hmrEvents.push("closed");
        });
        socket.on("framereceived", ({ payload }) => {
          if (String(payload) === '{"type":"connected"}') hmrConnected = true;
        });
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.status() >= 400 && !response.url().includes("/api/session"))
          errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
      });
      const initial = await page.goto(`${appOrigin}/runtime/${preview.id}/app/`);
      expect(initial?.status()).toBe(200);
      try {
        await visible.poll(() => hmrConnected, { timeout: 10000 }).toBe(true);
      } catch {
        throw new Error(`Starter HMR did not connect: ${JSON.stringify(hmrEvents)}`);
      }
      await page.screenshot({
        path: ".factory/screenshots/project-setup/starter-envbox-initial.png",
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Create an account", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Starter member");
      await page.getByLabel("Email", { exact: true }).fill(`${crypto.randomUUID()}@starter.test`);
      await page.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
      await page.reload();
      await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
      await page.screenshot({
        path: ".factory/screenshots/project-setup/starter-envbox-home.png",
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await visible(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
      const sourceStarted = performance.now();
      const source = await api(`/api/projects/${projectID}/source-workspace/ensure`, "POST", {});
      await eventually(
        () => api(`/api/workspaces/${source.workspaceID}/source`),
        (row) => row.state === "ready",
        "Starter source not ready",
        120_000,
      );
      timings["sourceMS"] = Math.round(performance.now() - sourceStarted);
      const runtimeStarted = performance.now();
      const runtime = await api(`/api/projects/${projectID}/personal-workspace/ensure`, "POST", {});
      await ready(runtime.id);
      terminal = await ownedRuntimeTerminal(factory.base, cookie, runtime.id);
      timings["terminalMS"] = Math.round(performance.now() - runtimeStarted);
      expect(await terminal.evaluate<string>("return process.cwd()")).toBe("/workspace/project");
      expect(
        await terminal.evaluate<boolean>(
          "return !!process.env.DATABASE_URL && !!process.env.BETTER_AUTH_SECRET",
        ),
      ).toBe(true);
      const activeTerminal = terminal;
      await eventually(
        () =>
          activeTerminal.evaluate<number>(
            "try{return (await fetch('http://127.0.0.1:4300/health',{signal:AbortSignal.timeout(1000)})).status}catch{return 0}",
          ),
        (status) => status === 200,
        "Starter development App did not become healthy",
        30_000,
      );
      expect(
        await terminal.evaluate<boolean>("return require('fs').existsSync('src/db/schema.ts')"),
      ).toBe(true);
      const [settings] =
        await database.client`SELECT manifest FROM factory.project_environment WHERE project_id=${projectID} AND environment='development'`;
      expect(settings?.["manifest"].variables).toHaveLength(3);
      console.log(JSON.stringify({ journey: "Starter Envbox", timings }));
      if (process.env["FACTORY_RUN_STARTER_DELIVERY_PROOF"] === "1")
        await starterDelivery({ database, projectID, api });
      succeeded = true;
    } finally {
      terminal?.close();
      await browser.close();
      if (!succeeded && projectID) {
        // Keep completed paid work and its external identities for explicit continuation.
        // Stop only this fixture's listener/cache, never its admitted runtime operations.
        console.log(
          JSON.stringify({
            retainedStarter: {
              id: factory.id,
              base: factory.base,
              directory,
              projectID,
              setupID,
              slug,
            },
          }),
        );
        await database.client.end({ timeout: 2 });
        await factory.pause();
      } else {
        if (projectID) {
          if (factory.processes.at(-1)?.exitCode !== null) await factory.start();
          for (const attempt of await attempts())
            if (attempt.state !== "stopped") {
              await api(`/api/runtime-attempts/${attempt.id}/stop`, "POST", {});
              await eventually(
                async () => (await attempts()).find((row) => row.id === attempt.id)?.state,
                (state) => state === "stopped",
                "Starter cleanup did not Stop",
                150_000,
              );
            }
          const sources = createWorkspaceSourceController(
            database,
            "owned-process-auth-secret-not-a-production-credential",
          );
          try {
            await removeOwnedProjectSources(database, projectID, async (id) => {
              const [workspace] = await database.client<{ ownerID: string | null }[]>`
                SELECT owner_user_id AS "ownerID" FROM factory.development_workspace WHERE id=${id} AND project_id=${projectID}`;
              if (!workspace) throw new Error("Owned Starter cleanup target disappeared");
              // Personal source Stop retains its real owner, not the bootstrap admin session.
              return sources.stop(id, workspace.ownerID ?? "01994a7d-0000-7000-8000-000000000001");
            });
          } finally {
            await sources.close();
          }
        }
        if (
          setupID &&
          (await forge.setupRepository({ owner: "factory-mutation", name: slug }, setupID))
        ) {
          const deletion = await fetch(
            `http://127.0.0.1:33030/api/v1/repos/factory-mutation/${slug}`,
            { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
          );
          expect(deletion.ok).toBe(true);
        }
        await database.client.end({ timeout: 2 });
        await factory.dispose();
        await bao.dispose();
        await rm(directory, { recursive: true });
      }
    }
  },
  2_400_000,
);
