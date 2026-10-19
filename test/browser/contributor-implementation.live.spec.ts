import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { signIn, deleteFactoryProject, stopProjectRuntimes } from "../support/factory-fixture";
import { fixtureNamespace, removeFixtureNamespace } from "../support/owned-namespace";
import { recordedEditorIdentity } from "../fixtures/editor-source-resources";
import { luminance, rgb } from "../support/visual-contrast";

const origin = "http://127.0.0.1:3000";
const repository = { owner: "factory-mutation", name: "runtime-fixture" };

for (const restore of [false, true])
  test(
    restore
      ? "a real Contributor commissions background Build; a Developer uses and restores retained Theia files"
      : "Slice 21 real draft, Luna confirmation and explicit Terra Build handoff",
    async ({ page, browser }) => {
      test.setTimeout(1_080_000);
      const db = createDatabase(2);
      const slug = `contributor-live-${crypto.randomUUID().slice(0, 8)}`;
      let ticketID = "";
      let title = "Ship the scoped version update";
      const password = "owned-contributor-journey-password";
      const users: Array<{ id: string; email: string }> = [];
      const contexts = [await browser.newContext(), await browser.newContext()];
      let projectID = "";
      let branch = "";
      let changeID = "";
      const evidence = `.factory/screenshots/${slug}`;
      const timings: Record<string, number> = {};
      async function login(current: Page, email: string) {
        await current.goto(origin);
        await current.getByLabel("Email", { exact: true }).fill(email);
        await current.getByLabel("Password", { exact: true }).fill(password);
        await current.getByRole("button", { name: "Sign in", exact: true }).click();
        await current.getByRole("button", { name: "Open project menu", exact: true }).click();
        await current.getByRole("button").filter({ hasText: slug }).click();
      }
      async function openTicket(current: Page) {
        await current.locator(".ticket-card-body").filter({ hasText: title }).click();
      }
      try {
        await mkdir(evidence, { recursive: true });
        // This admin only provisions/cleans fixtures; source editing belongs to the owned Developer.
        await page.route("**/api/projects/*/source-workspace/ensure", (route) =>
          route.fulfill({
            status: 503,
            json: { error: "Fixture administrator does not open source" },
          }),
        );
        await page.route("**/api/projects/*/developer-ide/ensure", (route) =>
          route.fulfill({
            status: 503,
            json: { error: "Fixture administrator does not open IDE" },
          }),
        );
        await signIn(page);
        await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
        const { session } = await (await page.request.get("/api/session")).json();
        // Isolate the Ticket journey from registration's concurrent Staging and Knowledge startup.
        projectID = crypto.randomUUID();
        await db.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${slug}, 'Contributor live journey',
        'http://127.0.0.1:33030/factory-mutation/runtime-fixture.git', 'main', '.devcontainer/devcontainer.json', ${session.user.id})`;
        for (const role of ["product-contributor", "developer"] as const) {
          const email = `${role}-${slug}@factory.local`;
          const created = await page.request.post("/api/admin/users", {
            headers: { origin },
            data: { name: role, email, password },
          });
          expect(created.status()).toBe(201);
          users.push(await created.json());
          expect(
            (
              await page.request.post(`/api/projects/${projectID}/members`, {
                headers: { origin },
                data: { email, role },
              })
            ).ok(),
          ).toBe(true);
        }
        const contributor = await contexts[0]!.newPage();
        const developer = await contexts[1]!.newPage();
        await login(contributor, users[0]!.email);
        await contributor.getByRole("button", { name: "New Ticket", exact: true }).click();
        await contributor.getByRole("textbox", { name: "Ticket title", exact: true }).fill(title);
        await contributor
          .getByRole("textbox", { name: "Ticket description", exact: true })
          .fill(
            `Change src/version.txt to contain exactly ${slug} followed by a newline so our product contributors can identify this version. Keep the existing application intact. Acceptance: src/version.txt has the exact value and node --check src/server.mjs passes. Do not change dependencies, runtime configuration or other files. These decisions are settled. Propose the complete Ticket immediately without questions.`,
          );
        await contributor
          .getByRole("button", { name: "Elaborate requirements", exact: true })
          .click();
        await expect(
          contributor.getByRole("article", { name: "Elaborated requirements" }),
        ).toBeVisible({ timeout: 60_000 });
        const [createdTicket] = await db.client<
          Array<{ id: string }>
        >`SELECT id FROM factory.ticket WHERE project_id=${projectID}`;
        if (!createdTicket) throw new Error("Draft did not publish");
        ticketID = createdTicket.id;
        const [planning] = await db.client<
          Array<{ model: string }>
        >`SELECT authority->>'modelId' AS model FROM factory.agent_turn WHERE ticket_id=${ticketID}`;
        expect(planning?.model).toBe("gpt-6-luna");
        await contributor.screenshot({ path: `${evidence}/requirements-proposal.png` });
        await contributor.getByRole("button", { name: "Confirm answers", exact: true }).click();
        const [accepted] = await db.client<
          Array<{ title: string }>
        >`SELECT title FROM factory.ticket WHERE id=${ticketID}`;
        title = accepted!.title;
        await contributor.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
        await expect(contributor.getByRole("button", { name: "IDE", exact: true })).toHaveCount(0);
        await contributor.getByRole("button", { name: "Implement", exact: true }).click();
        await expect(
          contributor.getByRole("button", { name: "Implement", exact: true }),
        ).toHaveCount(0);
        await expect(contributor.getByRole("complementary", { name: "Agent panel" })).toHaveCount(
          0,
        );
        await expect(contributor.getByRole("tab", { name: /^IDE/ })).toHaveCount(0);
        await contributor.screenshot({ path: `${evidence}/contributor-background-build.png` });
        await expect
          .poll(async () => {
            const [change] = await db.client<
              Array<{ id: string; branch: string }>
            >`SELECT id, branch_name AS branch FROM factory.change WHERE ticket_id = ${ticketID}`;
            if (change) {
              changeID = change.id;
              branch = change.branch;
            }
            return !!change;
          })
          .toBe(true);
        await login(developer, users[1]!.email);
        await openTicket(developer);
        const cold = performance.now();
        await developer.getByRole("button", { name: "Open IDE", exact: true }).click();
        const frame = developer.locator('iframe[title="Factory IDE"]');
        const ide = frame.contentFrame();
        await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 600_000 });
        await expect(ide.locator(".theia-preload")).toHaveCount(0);
        timings["coldShellMS"] = Math.round(performance.now() - cold);
        const sourceFolder = ide.getByText("src", { exact: true }).first();
        await expect(sourceFolder).toBeVisible();
        await sourceFolder.click();
        const sourceFile = ide.getByText("server.mjs", { exact: true }).first();
        await expect(sourceFile).toBeVisible();
        await sourceFile.click();
        const editor = ide.locator(".monaco-editor:visible .view-lines").first();
        await expect(editor).toContainText("createServer");
        timings["coldEditorMS"] = Math.round(performance.now() - cold);
        await developer.screenshot({ path: `${evidence}/developer-editor.png` });
        const navigationColors = await ide
          .locator(".lm-TabBar.theia-app-left")
          .evaluate((element) => {
            const container = element.closest(".theia-app-sidebar-container");
            if (!container) throw new Error("Missing IDE activity bar");
            return {
              background: getComputedStyle(container).backgroundColor,
              icons: [...element.querySelectorAll(".lm-TabBar-tabIcon")].map(
                (icon) => getComputedStyle(icon).color,
              ),
            };
          });
        expect(navigationColors.icons.length).toBeGreaterThanOrEqual(2);
        const background = luminance(rgb(navigationColors.background).channels);
        for (const color of navigationColors.icons) {
          const light = luminance(rgb(color).channels);
          expect(
            (Math.max(background, light) + 0.05) / (Math.min(background, light) + 0.05),
          ).toBeGreaterThanOrEqual(3);
        }
        const timeOrigin = await ide.locator("body").evaluate(() => performance.timeOrigin);
        await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
        const terminal = ide.locator(".factory-terminal-host:not([hidden])");
        await expect(terminal).toHaveAttribute("data-connection-state", "connected", {
          timeout: 180_000,
        });
        await expect(editor).toBeVisible();
        timings["coldTerminalMS"] = Math.round(performance.now() - cold);
        const [attempt] = await db.client<
          Array<{ id: string }>
        >`SELECT runtime_attempt_id AS id FROM factory.change WHERE id = ${changeID}`;
        expect(
          (
            await contributor.request.get(
              `/api/runtime-access?path=${encodeURIComponent(`/runtime/${attempt!.id}/ide/`)}`,
              { maxRedirects: 0 },
            )
          ).status(),
        ).toBe(403);
        await expect
          .poll(
            async () => {
              const [turn] = await db.client<
                Array<{ state: string; summary: string | null }>
              >`SELECT state, outcome_summary AS summary FROM factory.agent_turn WHERE change_id = ${changeID} ORDER BY created_at DESC LIMIT 1`;
              if (turn && ["failed", "uncertain", "stopped"].includes(turn.state))
                throw new Error(`Build ${turn.state}: ${turn.summary?.slice(0, 200)}`);
              return turn?.state;
            },
            { timeout: 360_000, intervals: [1_000, 2_000] },
          )
          .toBe("completed");
        await terminal.locator(".xterm").click({ force: true });
        await developer.keyboard.type(
          `printf '${slug}\\n' > factory-human-draft.txt; printf 'built-version='; cat src/version.txt; pwd`,
        );
        await developer.keyboard.press("Enter");
        await expect(terminal.locator(".xterm-rows")).toContainText(`built-version=${slug}`);
        await expect(terminal.locator(".xterm-rows")).toContainText("/workspace/project");
        await developer.screenshot({ path: `${evidence}/developer-terminal.png` });
        await developer.setViewportSize({ width: 430, height: 900 });
        await developer.screenshot({ path: `${evidence}/developer-terminal-narrow.png` });
        await developer.setViewportSize({ width: 1280, height: 720 });
        await developer.getByRole("button", { name: "Minimize workspace", exact: true }).click();
        const retained = performance.now();
        await developer.getByRole("button", { name: "IDE", exact: true }).click();
        const choice = developer.getByRole("menuitem").filter({ hasText: title });
        if (await choice.isVisible()) await choice.click();
        await expect(terminal).toHaveAttribute("data-connection-state", "connected");
        await expect(editor).toContainText("createServer");
        expect(await ide.locator("body").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        timings["retainedEditorAndTerminalMS"] = Math.round(performance.now() - retained);
        if (restore) {
          await contributor.getByRole("button", { name: "Ticket actions", exact: true }).click();
          await contributor.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
          await expect(
            contributor.getByRole("button", { name: "Restore", exact: true }),
          ).toBeEnabled({
            timeout: 180_000,
          });
          const verificationAttempts = await db.client<Array<{ id: string; state: string }>>`
      SELECT attempt.id, attempt.state FROM factory.runtime_attempt attempt
      JOIN factory.verification verification ON verification.id = attempt.verification_id
      WHERE verification.change_id = ${changeID}`;
          expect(verificationAttempts.every((attempt) => attempt.state === "stopped")).toBe(true);
          const turnCount = (
            await db.client`SELECT id FROM factory.agent_turn WHERE change_id = ${changeID}`
          ).length;
          await contributor.getByRole("button", { name: "Restore", exact: true }).click();
          await expect(
            contributor.getByRole("button", { name: "Restore", exact: true }),
          ).toHaveCount(0);
          await developer.getByRole("tab", { name: title, exact: true }).click();
          await developer.getByRole("button", { name: "Open IDE", exact: true }).click();
          await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 600_000 });
          await expect(ide.locator(".theia-preload")).toHaveCount(0);
          await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
          await expect(terminal).toHaveAttribute("data-connection-state", "connected");
          await terminal.locator(".xterm").click({ force: true });
          await developer.keyboard.type(
            "printf 'retained-human-file='; cat factory-human-draft.txt",
          );
          await developer.keyboard.press("Enter");
          await expect(terminal.locator(".xterm-rows")).toContainText(
            `retained-human-file=${slug}`,
          );
          expect(
            (await db.client`SELECT id FROM factory.agent_turn WHERE change_id = ${changeID}`)
              .length,
          ).toBe(turnCount);
          expect(
            await db.client`
      SELECT attempt.id FROM factory.runtime_attempt attempt
      JOIN factory.verification verification ON verification.id = attempt.verification_id
      WHERE verification.change_id = ${changeID} AND attempt.state <> 'stopped'`,
          ).toHaveLength(0);
          await developer.screenshot({ path: `${evidence}/restored-human-file.png` });
        }
        await writeFile(
          `${evidence}/timings.json`,
          JSON.stringify(
            {
              timings,
              meaning:
                "Time from explicit Open IDE to visible shell, rendered source editor and connected native PTY. Retained time requires the same iframe with visible source and connected PTY. Image availability and existing Build startup affect cold results.",
              navigationColors,
              ram: "No measured RAM usage; Kubernetes Metrics API is unavailable.",
            },
            null,
            2,
          ),
        );
      } catch (error) {
        for (const [index, context] of contexts.entries()) {
          const current = context.pages()[0];
          if (current && !current.isClosed())
            await current.screenshot({ path: `${evidence}/failure-${index}.png` });
        }
        const attempts = await db.client`
      SELECT id, state, failure, kubernetes_namespace, kubernetes_pod_name, updated_at
      FROM factory.runtime_attempt WHERE project_id = ${projectID || null}`;
        const turns = await db.client`
      SELECT state, outcome_summary FROM factory.agent_turn WHERE change_id = ${changeID || null}`;
        await writeFile(`${evidence}/failure.json`, JSON.stringify({ attempts, turns }, null, 2));
        throw error;
      } finally {
        if (projectID) {
          const sources = await db.client<
            Array<{ id: string; namespace: string; ownerID: string | null }>
          >`
        SELECT id,kubernetes_namespace AS namespace,owner_user_id AS "ownerID" FROM factory.development_workspace WHERE project_id=${projectID}`;
          const namespaces = [];
          for (const source of sources) {
            const namespace = await fixtureNamespace(source.namespace, source.id);
            if (namespace) namespaces.push(namespace);
          }
          if (changeID)
            await page.request.post(`/api/changes/${changeID}/cancel`, { headers: { origin } });
          await stopProjectRuntimes(page.request, projectID);
          for (const source of sources) {
            const ownerIndex = users.findIndex((user) => user.id === source.ownerID);
            const request = ownerIndex < 0 ? page.request : contexts[ownerIndex]!.request;
            const stopped = await request.post(
              `${origin}/api/workspaces/${source.id}/source/stop`,
              {
                headers: { origin },
              },
            );
            expect(stopped.status()).toBe(202);
          }
          await expect
            .poll(
              async () =>
                (
                  await db.client`SELECT s.workspace_id FROM factory.workspace_source s
        JOIN factory.development_workspace w ON w.id=s.workspace_id WHERE w.project_id=${projectID} AND s.state<>'stopped'`
                ).length,
              { timeout: 60_000 },
            )
            .toBe(0);
          for (const namespace of namespaces) await removeFixtureNamespace(namespace);
          for (const [index, user] of users.entries()) {
            const [editor] = await db.client<
              Array<{ state: string }>
            >`SELECT state FROM factory.developer_ide WHERE user_id=${user.id}`;
            if (!editor) continue;
            const identity = await recordedEditorIdentity(db, user.id);
            expect(identity).toBeDefined();
            if (!identity) continue;
            const namespace = await fixtureNamespace(identity.namespace, user.id);
            expect(
              (
                await contexts[index]!.request.post(`${origin}/api/developer-ide/stop`, {
                  headers: { origin },
                })
              ).status(),
            ).toBe(202);
            await expect
              .poll(
                async () =>
                  (
                    await db.client`SELECT state FROM factory.developer_ide WHERE user_id=${user.id}`
                  )[0]?.["state"],
                { timeout: 60_000 },
              )
              .toBe("stopped");
            if (namespace) await removeFixtureNamespace(namespace);
            await db.client`DELETE FROM factory.developer_ide WHERE user_id=${user.id} AND state='stopped'`;
          }
          await deleteFactoryProject(projectID);
          if (branch) {
            const forge = createForgejoClient({
              apiURL: "http://127.0.0.1:33030/api/v1/",
              token: (await readFile(".factory/forgejo-token", "utf8")).trim(),
            });
            await forge.deleteBranch(repository, branch);
          }
        }
        for (const user of users)
          await db.client`DELETE FROM auth."user" WHERE id = ${user.id} AND email = ${user.email}`;
        for (const context of contexts) await context.close();
        await db.client.end();
      }
    },
  );
