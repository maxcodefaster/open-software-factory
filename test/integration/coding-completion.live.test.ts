import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as visible } from "@playwright/test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { agentViewSchema, deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { loadInstallation, installationDirectory } from "../../scripts/factory/installation";
import { zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { eventually } from "../fixtures/factory-process";
import { runtimeAccessCookie } from "../fixtures/runtime-access";
import { verifyCodingSource } from "../fixtures/coding-source";

const installationName = process.env["FACTORY_CODING_COMPLETION_INSTALLATION"];

test.skipIf(!installationName)(
  "a fresh Starter feature reaches exact Verification and Delivery without outside source edits",
  async () => {
    if (!installationName) throw new Error("Explicit disposable coding installation required");
    const root = resolve(import.meta.dir, "../..");
    const installation = await loadInstallation(root, installationName);
    if (installation.phase !== "active" || !installationName.startsWith("coding-proof-"))
      throw new Error("Coding proof requires its own active coding-proof disposable installation");
    const directory = installationDirectory(root, installationName);
    const runID = crypto.randomUUID();
    const evidence = resolve(
      root,
      ".factory/test-results/coding-completion",
      installationName,
      runID,
    );
    await mkdir(evidence, { recursive: true });
    const base = `http://127.0.0.1:${installation.ports.factory}`;
    const password = (await readFile(resolve(directory, "admin-password"), "utf8")).trim();
    const databasePassword = (
      await readFile(resolve(directory, "database-password"), "utf8")
    ).trim();
    const previousURL = process.env["DATABASE_URL"];
    let database: ReturnType<typeof createDatabase>;
    try {
      process.env["DATABASE_URL"] =
        `postgresql://factory:${databasePassword}@127.0.0.1:${installation.ports.postgres}/factory`;
      database = createDatabase(2);
    } finally {
      if (previousURL === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previousURL;
    }
    const browser = await chromium.launch({ headless: true });
    let cookie = "";
    let projectID = "";
    let changeID = "";
    let failure: unknown;
    const commandID = crypto.randomUUID();
    const ticketID = crypto.randomUUID();
    const result: Record<string, unknown> = {
      runID,
      installation: installationName,
      commandID,
      ticketID,
    };
    async function api(path: string, method = "GET", body?: unknown) {
      const response = await fetch(base + path, {
        method,
        headers: { cookie, origin: base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`Coding proof ${method} ${path}: HTTP ${response.status}`);
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    async function captureFactory(label: string) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      try {
        await context.addCookies(
          cookie.split("; ").map((part) => ({
            name: part.slice(0, part.indexOf("=")),
            value: part.slice(part.indexOf("=") + 1),
            url: base,
          })),
        );
        const page = await context.newPage();
        await page.goto(base);
        await page.getByRole("button", { name: "Open project menu", exact: true }).click();
        await page
          .locator("#project-popover .project-choice")
          .filter({
            hasText: `coding-proof-${ticketID.slice(0, 8)}`,
          })
          .click();
        await visible(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
        if (label === "05-source-verified") {
          await page
            .getByRole("region", { name: "review", exact: true })
            .getByRole("button")
            .filter({ hasText: "Add a launch checklist" })
            .click();
          await visible(page.getByRole("button", { name: "Deliver", exact: true })).toBeVisible();
        }
        if (label === "06-delivered") {
          await page.getByRole("button", { name: /^History/ }).click();
          await page
            .getByRole("button")
            .filter({ hasText: "Add a launch checklist" })
            .last()
            .click();
          await visible(
            page.getByRole("button", { name: "Create follow-up", exact: true }),
          ).toBeVisible();
        }
        await page.screenshot({ path: resolve(evidence, `${label}.png`) });
      } finally {
        await context.close();
      }
    }
    async function inspectApp(attemptID: string, label: string) {
      const access = await runtimeAccessCookie(base, cookie, attemptID, "app");
      const origin = `http://${attemptID.replaceAll("-", "")}.app.runtime.localhost:${installation.ports.factory}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      try {
        await context.addCookies(
          access.split("; ").map((part) => ({
            name: part.slice(0, part.indexOf("=")),
            value: part.slice(part.indexOf("=") + 1),
            url: origin,
          })),
        );
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/runtime/${attemptID}/app/`);
        await page.getByRole("button", { name: "Create an account", exact: true }).click();
        await page.getByLabel("Name", { exact: true }).fill("Coding proof member");
        await page
          .getByLabel("Email", { exact: true })
          .fill(`${crypto.randomUUID()}@coding-proof.test`);
        await page.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
        await page.getByRole("button", { name: "Create account", exact: true }).click();
        await visible(
          page.getByRole("heading", { name: "Launch checklist", exact: true }),
        ).toBeVisible();
        const counter = page.getByText("0 of 3 ready", { exact: true });
        await visible(counter).toBeVisible();
        const reset = page.getByRole("button", { name: "Reset checklist", exact: true });
        await visible(reset).toBeDisabled();
        for (const name of ["Tests passed", "Release notes written", "Rollback ready"])
          await page.getByRole("checkbox", { name, exact: true }).check();
        await visible(page.getByText("3 of 3 ready", { exact: true })).toBeVisible();
        await page.screenshot({ path: resolve(evidence, `${label}-wide.png`) });
        await reset.click();
        await visible(counter).toBeVisible();
        await visible(reset).toBeDisabled();
        await page.getByRole("checkbox", { name: "Tests passed", exact: true }).focus();
        await page.keyboard.press("Space");
        await visible(page.getByText("1 of 3 ready", { exact: true })).toBeVisible();
        await page.reload();
        await visible(counter).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: resolve(evidence, `${label}-narrow.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          390,
        );
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await visible(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    try {
      const login = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ email: `admin-${installationName}@factory.local`, password }),
      });
      if (!login.ok) throw new Error("Owned coding administrator sign-in failed");
      cookie = login.headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .join("; ");
      const draft = await api("/api/project-setup", "POST");
      const saved = await api("/api/project-setup", "PUT", {
        id: draft.id,
        version: draft.version,
        name: "Unassisted coding proof",
        slug: `coding-proof-${ticketID.slice(0, 8)}`,
        kind: "starter",
        sourceURL: "",
      });
      const created = await api("/api/project-setup/create", "POST", {
        id: saved.id,
        version: saved.version,
        commandID: crypto.randomUUID(),
      });
      expect(created.state).toBe("created");
      projectID = created.projectID;
      result["projectID"] = projectID;
      await captureFactory("01-project-created");
      await eventually(
        async () => {
          await Bun.sleep(500);
          const rows = await api(`/api/projects/${projectID}/setup`);
          const failure = rows.find(
            (row: { task: string; state: string }) =>
              ["main-preview", "protection", "development-secrets"].includes(row.task) &&
              row.state === "failed",
          );
          if (failure) throw new Error(`Owned Starter ${failure.task} failed: ${failure.failure}`);
          return rows;
        },
        (rows) =>
          ["main-preview", "protection", "development-secrets"].every((task) =>
            rows.some(
              (row: { task: string; state: string }) => row.task === task && row.state === "ready",
            ),
          ),
        "Owned Starter preparation did not finish",
        900_000,
      );
      await captureFactory("02-starter-ready");
      const { session } = await api("/api/session");
      const zero = zeroDrizzle(zeroSchema, database.db);
      await zero.transaction((tx) =>
        zeroServerMutators.tickets.create.fn({
          tx,
          ctx: { userId: session.user.id, systemManager: true },
          args: {
            id: ticketID,
            projectId: projectID,
            title: "Add a launch checklist",
            description: "Add a small interactive checklist to the existing authenticated home.",
          },
        }),
      );
      const revision = await api(`/api/tickets/${ticketID}/requirements`, "POST", {
        summary:
          "Add a Launch checklist to the existing authenticated home. Implement it in the real application, not an unused module. Keep existing authentication and runtime configuration intact.",
        acceptanceCriteria: [
          "The protected home includes a Launch checklist heading and three accessible native checkboxes labelled Tests passed, Release notes written and Rollback ready.",
          "Initially show 0 of 3 ready. Checking and unchecking items updates the visible count. Reset checklist unchecks every item and is disabled when none are checked.",
          "Checklist state is intentionally page-local: reloading starts at 0 of 3 ready while the authenticated session remains valid. Signup, signin and signout continue working.",
          "The checklist is keyboard usable and has no horizontal overflow at 390px. Use the actual Factory browser to inspect the App DOM, console and screenshot, reading the returned JPEG. Use a uniquely owned test account for protected-page inspection.",
          "Add focused regressions for counting, toggling and reset using the repository's existing test tools. Run the normal npm run check without NODE_ENV overrides. Do not modify runtime configuration, dependencies or the verification workflow.",
        ],
        nonGoals: [
          "Persistence, backend API changes, new dependencies, unrelated redesign, authentication changes",
        ],
      });
      const change = await api(`/api/tickets/${ticketID}/implement`, "POST", {
        commandId: commandID,
        revisionId: revision.id,
      });
      changeID = change.id;
      result["changeID"] = changeID;
      await captureFactory("03-build-admitted");
      await eventually(
        async () => {
          await Bun.sleep(1_000);
          const view = agentViewSchema.parse(await api(`/api/changes/${changeID}/agent?history=0`));
          if (view.turn && ["failed", "stopped", "uncertain"].includes(view.turn.state))
            throw new Error(
              `Unassisted Build ${view.turn.state}: ${view.lastError ?? view.turn.summary}`,
            );
          return view;
        },
        (view) => view.state === "committed",
        "Unassisted Build did not submit source",
        900_000,
      );
      await captureFactory("04-source-submitted");
      const delivery = await eventually(
        async () => {
          await Bun.sleep(1_000);
          return deliveryViewSchema.parse(await api(`/api/changes/${changeID}/delivery`));
        },
        (view) => view.verificationState === "succeeded",
        "Unassisted source did not pass exact Verification",
        900_000,
      );
      if (!delivery?.verificationCommitSha) throw new Error("Exact verified source is missing");
      result["verifiedSHA"] = delivery.verificationCommitSha;
      const [source] = await database.client<Array<{ baseSHA: string; slug: string }>>`
        SELECT change.base_sha AS "baseSHA",project.slug FROM factory.change change
        JOIN factory.project project ON project.id=change.project_id WHERE change.id=${changeID}`;
      if (!source) throw new Error("Owned source identity is missing");
      result["sourceAcceptance"] = await verifyCodingSource({
        forge: createForgejoClient({
          apiURL: `http://127.0.0.1:${installation.ports.forgejo}/api/v1/`,
          token: (await readFile(resolve(directory, "forgejo-token"), "utf8")).trim(),
        }),
        repository: { owner: "factory-mutation", name: source.slug },
        baseSHA: source.baseSHA,
        commitSHA: delivery.verificationCommitSha,
      });
      await captureFactory("05-source-verified");
      const turns = await database.client<
        Array<{ id: string; state: string; kind: string; commandID: string }>
      >`
        SELECT id,state,input->>'kind' AS kind,command_id AS "commandID"
        FROM factory.agent_turn WHERE change_id=${changeID} ORDER BY created_at`;
      expect(turns[0]).toMatchObject({ commandID, kind: "change-start", state: "completed" });
      // Native implementation and the existing automatic CI repair path are
      // allowed. A human continuation or outside source rescue is not.
      expect(
        turns.slice(1).every((turn) => turn.kind === "change-repair" && turn.state === "completed"),
      ).toBe(true);
      const agent = agentViewSchema.parse(await api(`/api/changes/${changeID}/agent`));
      const imageReads = agent.messages.filter(
        (message) =>
          message.activity?.status === "completed" &&
          message.text.startsWith("Read /tmp/factory-build-browser-") &&
          message.text.endsWith("/screenshot.jpg"),
      );
      expect(imageReads.length).toBeGreaterThan(0);
      const sessions = await database.client<
        Array<{ state: string; context: unknown; cleaned: boolean }>
      >`
        SELECT state,inspection_context AS context,cleanup_confirmed_at IS NOT NULL AS cleaned
        FROM factory.build_browser_session WHERE change_id=${changeID}`;
      expect(sessions.some((value) => value.context)).toBe(true);
      expect(sessions.every((value) => value.state === "closed" && value.cleaned)).toBe(true);
      const [development] = await database.client<Array<{ id: string }>>`
        SELECT runtime_attempt_id AS id FROM factory.change WHERE id=${changeID}`;
      if (!development) throw new Error("Owned Ticket Workspace is missing");
      await inspectApp(development.id, "development");
      await api(`/api/changes/${changeID}/delivery/approve`, "POST", {});
      const staging = await eventually(
        async () => {
          const [row] = await database.client<
            Array<{ id: string; state: string; revision: string; changeState: string }>
          >`
            SELECT attempt.id,attempt.state,preview.revision,change.state AS "changeState"
            FROM factory.staging_preview preview JOIN factory.runtime_attempt attempt ON attempt.id=preview.runtime_attempt_id
            JOIN factory.change change ON change.project_id=preview.project_id
            WHERE change.id=${changeID}`;
          return row;
        },
        (row) => row?.state === "ready" && row.changeState === "delivered",
        "Verified feature did not reach healthy Staging",
        900_000,
      );
      if (!staging) throw new Error("Owned Staging is missing");
      expect(staging.revision).toBe(delivery.verificationCommitSha);
      await inspectApp(staging.id, "staging");
      await captureFactory("06-delivered");
      result["status"] = "passed";
      result["turns"] = turns;
      result["browserSessions"] = sessions;
      result["nativeImageReads"] = imageReads.map(({ id, text }) => ({ id, text }));
      result["outsideSourceEdits"] = 0;
      result["stagingSHA"] = staging?.revision;
    } catch (cause) {
      result["status"] = "failed";
      result["error"] = cause instanceof Error ? cause.message : "Unknown coding proof failure";
      failure = cause;
    } finally {
      try {
        await browser.close();
        if (projectID) {
          if (changeID) await api(`/api/changes/${changeID}/agent/stop`, "POST", {});
          const attempts = await database.client<Array<{ id: string }>>`
            SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID} AND state <> 'stopped'`;
          for (const attempt of attempts)
            await api(`/api/runtime-attempts/${attempt.id}/stop`, "POST", {});
          await eventually(
            async () => database.client`SELECT id FROM factory.runtime_attempt
              WHERE project_id=${projectID} AND state <> 'stopped'`,
            (rows) => rows.length === 0,
            "Owned coding proof execution did not Stop",
            180_000,
          );
        }
        result["ownedExecutionStopped"] = true;
      } catch (cause) {
        result["status"] = "failed";
        result["cleanupError"] = cause instanceof Error ? cause.message : "Cleanup unconfirmed";
        failure ??= cause;
      } finally {
        await writeFile(resolve(evidence, "result.json"), JSON.stringify(result, null, 2));
        await database.client.end();
      }
    }
    if (failure) throw failure;
  },
  3_600_000,
);
