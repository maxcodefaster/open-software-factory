import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect as browserExpect, chromium } from "@playwright/test";
import { agentViewSchema, deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { installationDirectory, loadInstallation } from "../../scripts/factory/installation";
import { verifyCodingSource } from "../fixtures/coding-source";
import { removeOwnedProjectSources } from "../fixtures/editor-source-resources";
import { eventually } from "../fixtures/factory-process";
import { openProjectMenu } from "../fixtures/project-menu";
import { runtimeAccessCookie } from "../fixtures/runtime-access";

// Bun does not load playwright.config.ts. Match the repository's normal browser
// assertion window rather than accidentally using Playwright's 5-second default.
const visible = browserExpect.configure({ timeout: 30_000 });
const installationName = process.env["FACTORY_CODING_COMPLETION_INSTALLATION"];
const selectedPath = process.env["FACTORY_CODING_COMPLETION_PATH"];
if (selectedPath && !["manual", "interview"].includes(selectedPath))
  throw new Error("Coding completion path must be manual or interview");

for (const requirementsPath of ["manual", "interview"] as const)
  test.skipIf(!installationName || Boolean(selectedPath && selectedPath !== requirementsPath))(
    `${requirementsPath} Requirements take a fresh Starter through independent review and deliberate Delivery without outside source edits`,
    async () => {
      if (!installationName) throw new Error("Explicit disposable coding installation required");
      const root = resolve(import.meta.dir, "../..");
      const installation = await loadInstallation(root, installationName);
      if (installation.phase !== "active" || !installationName.startsWith("coding-proof-"))
        throw new Error(
          "Coding proof requires its own active coding-proof disposable installation",
        );
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
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let cookie = "";
      let projectID = "";
      let changeID = "";
      let failure: unknown;
      let commandID = "";
      let ticketID = "";
      let title = "Add a launch checklist";
      const slug = `coding-proof-${runID.slice(0, 8)}`;
      const summary =
        "Add a Launch checklist to the existing authenticated home. Implement it in the real application, not an unused module. Keep existing authentication and runtime configuration intact.";
      const acceptanceCriteria = [
        "The protected home includes a Launch checklist heading and three accessible native checkboxes labelled Tests passed, Release notes written and Rollback ready.",
        "Initially show 0 of 3 ready. Checking and unchecking items updates the visible count. Reset checklist unchecks every item and is disabled when none are checked.",
        "Checklist state is intentionally page-local: reloading starts at 0 of 3 ready while the authenticated session remains valid. Signup, signin and signout continue working.",
        "The checklist is keyboard usable and has no horizontal overflow at 390px. Inspect the actual App DOM, console and screenshot with the provided Factory browser. Use a uniquely owned test account for protected-page inspection.",
        "Add focused regressions for counting, toggling and reset using the repository's existing test tools. Run the normal npm run check without NODE_ENV overrides. Do not modify runtime configuration, dependencies or the verification workflow.",
      ];
      const nonGoal =
        "Persistence, backend API changes, new dependencies, unrelated redesign, authentication changes";
      const result: Record<string, unknown> = {
        runID,
        installation: installationName,
        requirementsPath,
      };
      // Share the test's existing one-hour bound across the native journey.
      // Reserve its final five minutes for exact owned cleanup. A separate
      // 15-minute cutoff must not abandon healthy source/runtime preparation.
      const journeyDeadline = Date.now() + 3_300_000;
      const remainingJourneyMS = () => Math.max(1, journeyDeadline - Date.now());
      async function api(path: string, method = "GET", body?: unknown) {
        const response = await fetch(base + path, {
          method,
          headers: { cookie, origin: base, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok)
          throw new Error(`Coding proof ${method} ${path}: HTTP ${response.status}`);
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }
      async function captureFactory(label: string) {
        await page.screenshot({ path: resolve(evidence, `${label}.png`) });
      }
      async function openTicket() {
        await page.getByRole("button", { name: "Desktop", exact: true }).click();
        await page.locator(".ticket-card-body").filter({ hasText: title }).click();
        await visible(
          page.getByRole("article", { name: "Ticket document", exact: true }),
        ).toBeVisible();
      }
      async function inspectApp(attemptID: string, label: string) {
        const access = await runtimeAccessCookie(base, cookie, attemptID, "app");
        const origin = `http://${attemptID.replaceAll("-", "")}-app.runtime.localhost:${installation.ports.factory}`;
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
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(390);
          await page.getByRole("button", { name: "Sign out", exact: true }).click();
          await visible(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
      try {
        await page.goto(base);
        await page
          .getByLabel("Email", { exact: true })
          .fill(`admin-${installationName}@factory.local`);
        await page.getByLabel("Password", { exact: true }).fill(password);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await visible(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
        cookie = (await context.cookies(base))
          .map(({ name, value }) => `${name}=${value}`)
          .join("; ");
        await captureFactory("00-clean-installation");
        await openProjectMenu(page);
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        const setup = page.getByRole("region", { name: "Project setup", exact: true });
        await setup
          .getByLabel("Project name", { exact: true })
          .fill(`Unassisted ${requirementsPath} proof`);
        await setup.getByLabel("Repository name", { exact: true }).fill(slug);
        await captureFactory("01-starter-setup");
        const creation = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/project-setup/create") &&
            response.request().method() === "POST",
        );
        await setup.getByRole("button", { name: "Create project", exact: true }).click();
        const response = await creation;
        expect(response.ok()).toBe(true);
        const submitted = await response.json();
        result["setupID"] = submitted.id;
        const created =
          submitted.state === "created"
            ? submitted
            : await eventually(
                async () => {
                  await Bun.sleep(1_000);
                  const value = await api("/api/project-setup");
                  if (value?.id !== submitted.id)
                    throw new Error("The admitted Project setup identity changed");
                  if (value.state === "failed")
                    throw new Error(`Owned Project creation failed: ${value.failure}`);
                  return value;
                },
                (value) => value.state === "created",
                "Owned Project creation did not settle without manual intervention",
                remainingJourneyMS(),
              );
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
                ["configuration", "protection", "development-secrets"].includes(row.task) &&
                row.state === "failed",
            );
            if (failure)
              throw new Error(`Owned Starter ${failure.task} failed: ${failure.failure}`);
            return rows;
          },
          (rows) =>
            ["configuration", "protection", "development-secrets"].every((task) =>
              rows.some(
                (row: { task: string; state: string }) =>
                  row.task === task && row.state === "ready",
              ),
            ),
          "Owned Starter preparation did not finish",
          remainingJourneyMS(),
        );
        const initialWiki = await eventually(
          async () => {
            const [generation] = await database.client<{ state: string; failure: string | null }[]>`
              SELECT state,failure FROM factory.knowledge_generation
              WHERE project_id=${projectID} ORDER BY created_at LIMIT 1`;
            return generation;
          },
          (generation) => !!generation && ["succeeded", "failed"].includes(generation.state),
          "Initial Wiki generation did not settle",
          remainingJourneyMS(),
        );
        result["initialWiki"] = initialWiki;
        await captureFactory("02-starter-ready");
        await setup.getByRole("button", { name: "Open project", exact: true }).click();
        const [wiki] = await database.client<{ id: string; title: string }[]>`
        SELECT id,title FROM factory.knowledge_page WHERE project_id=${projectID} ORDER BY created_at LIMIT 1`;
        const note = `Human release note ${runID}: contact the release owner before production.`;
        if (wiki) {
          await page.getByRole("button", { name: "Knowledge", exact: true }).click();
          await page.getByRole("button", { name: wiki.title, exact: true }).click();
          await page.getByLabel("Edit Knowledge body", { exact: true }).click();
          const wikiEditor = page.getByRole("textbox", { name: "Knowledge body", exact: true });
          await wikiEditor.press("ControlOrMeta+End");
          await wikiEditor.press("Enter");
          await wikiEditor.pressSequentially(note);
          await eventually(
            async () =>
              database.client<
                { body: string }[]
              >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${wiki.id}`,
            (rows) => rows[0]?.body.includes(note) ?? false,
            "Human Wiki note did not save",
            30_000,
          );
          await captureFactory("02-wiki-human-note");
        }
        await page.getByRole("button", { name: "Desktop", exact: true }).click();
        await page.getByRole("button", { name: "New Ticket", exact: true }).click();
        await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(title);
        await page
          .getByRole("textbox", { name: "Ticket description", exact: true })
          .fill(
            requirementsPath === "manual"
              ? summary
              : [
                  summary,
                  ...acceptanceCriteria.filter((_text, index) => index !== 2),
                  `Out of scope: ${nonGoal}.`,
                  "One product decision is unresolved: should checklist progress survive a page reload? Ask me this question before proposing requirements. All other decisions are settled.",
                ].join("\n\n"),
          );
        await page.getByRole("button", { name: "Write requirements", exact: true }).click();
        await visible(
          page.getByRole("article", { name: "Ticket document", exact: true }),
        ).toBeVisible();
        const [ticket] = await database.client<
          { id: string }[]
        >`SELECT id FROM factory.ticket WHERE project_id=${projectID}`;
        if (!ticket) throw new Error("User-created Ticket is missing");
        ticketID = ticket.id;
        result["ticketID"] = ticketID;
        if (requirementsPath === "manual") {
          for (const [index, text] of acceptanceCriteria.entries()) {
            const criterion = page.getByRole("textbox", {
              name: `Acceptance criterion ${index + 1}`,
              exact: true,
            });
            if (index > 0) {
              const previous = page.getByRole("textbox", {
                name: `Acceptance criterion ${index}`,
                exact: true,
              });
              await previous.press("ControlOrMeta+End");
              await previous.pressSequentially(" /acceptance");
              await page
                .getByRole("menuitem", { name: "Acceptance criterion", exact: true })
                .click();
            }
            await criterion.fill(text);
          }
          await page.getByRole("textbox", { name: "Non-goal 1", exact: true }).fill(nonGoal);
          await page.getByRole("textbox", { name: "Ticket title", exact: true }).click();
          await visible(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
          expect(
            await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}`,
          ).toHaveLength(0);
        } else {
          await page.getByRole("button", { name: "Ask AI to clarify", exact: true }).click();
          const question = page.locator(".conversation-question");
          await visible(question).toBeVisible({ timeout: 90_000 });
          await captureFactory("02-interview-question");
          const answer = question.getByLabel("Custom answer", { exact: true });
          if (!(await answer.isVisible())) {
            const custom = question.getByRole("radio", { name: "Something else", exact: true });
            if (await custom.isVisible()) await custom.check();
            else
              await question
                .getByRole("radio", { name: /page.local|reset.*reload|reload.*reset|not persist/i })
                .check();
          }
          if (await answer.isVisible())
            await answer.fill(
              "Keep progress page-local. Reload resets the checklist to 0 of 3 ready without signing the member out. No persistence or backend changes. The remaining requirements are settled; propose the complete Ticket now.",
            );
          await captureFactory("02-interview-answer");
          await question.getByRole("button", { name: "Continue", exact: true }).click();
          await visible(
            page.getByRole("button", { name: "Confirm answers", exact: true }),
          ).toBeVisible({ timeout: 90_000 });
          await captureFactory("02-interview-proposal");
          await page.getByRole("button", { name: "Confirm answers", exact: true }).click();
          await visible(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
          const [confirmed] = await database.client<
            { title: string }[]
          >`SELECT title FROM factory.ticket WHERE id=${ticketID}`;
          if (!confirmed) throw new Error("Confirmed Ticket is missing");
          title = confirmed.title;
          const minimize = page.getByRole("button", { name: "Minimize Agent panel", exact: true });
          if (await minimize.isVisible()) await minimize.click();
        }
        await captureFactory("02-requirements-ready");
        const implementation = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/tickets/${ticketID}/implement`) &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Implement", exact: true }).click();
        const implementationResponse = await implementation;
        expect(implementationResponse.ok()).toBe(true);
        commandID = (implementationResponse.request().postDataJSON() as { commandId: string })
          .commandId;
        result["commandID"] = commandID;
        const change = await implementationResponse.json();
        changeID = change.id;
        result["changeID"] = changeID;
        await captureFactory("03-build-admitted");
        await page.reload();
        await openTicket();
        await captureFactory("03-reconnected-build");
        await eventually(
          async () => {
            await Bun.sleep(1_000);
            const view = agentViewSchema.parse(
              await api(`/api/changes/${changeID}/agent?history=0`),
            );
            if (view.turn && ["failed", "stopped", "uncertain"].includes(view.turn.state))
              throw new Error(
                `Unassisted Build ${view.turn.state}: ${view.lastError ?? view.turn.summary}`,
              );
            return view;
          },
          (view) => view.state === "committed",
          "Unassisted Build did not submit source",
          remainingJourneyMS(),
        );
        await captureFactory("04-source-submitted");
        const delivery = await eventually(
          async () => {
            await Bun.sleep(1_000);
            const view = deliveryViewSchema.parse(await api(`/api/changes/${changeID}/delivery`));
            if (["incomplete", "failed", "stopped"].includes(view.reviewState ?? ""))
              throw new Error(`Independent review ${view.reviewState}: ${view.reviewSummary}`);
            return view;
          },
          (view) =>
            view.verificationState === "succeeded" &&
            view.reviewState === "passed" &&
            view.reviewCurrent === true,
          "Unassisted source did not pass exact Verification and independent review",
          remainingJourneyMS(),
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
        expect(turns.filter((turn) => turn.kind === "change-start")).toHaveLength(1);
        // Only native implementation, independent review and automatic correction
        // are allowed. A human continuation or outside source rescue is not.
        expect(
          turns
            .slice(1)
            .every(
              (turn) =>
                ["change-repair", "change-review"].includes(turn.kind) &&
                turn.state === "completed",
            ),
        ).toBe(true);
        expect(turns.some((turn) => turn.kind === "change-review")).toBe(true);
        const reviews = await database.client<
          {
            id: string;
            sha: string;
            verificationSHA: string;
            state: string;
            sessionID: string;
            model: string;
            reasoning: string;
          }[]
        >`
        SELECT review.id,review.commit_sha AS sha,verification.commit_sha AS "verificationSHA",review.state,
          intent.session_id AS "sessionID",turn.authority->>'modelId' AS model,
          turn.authority->>'codingReasoning' AS reasoning
        FROM factory.candidate_review review JOIN factory.verification verification ON verification.id=review.verification_id
        JOIN factory.agent_turn turn ON turn.id=review.turn_id
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
        WHERE review.change_id=${changeID} ORDER BY review.created_at`;
        const passedReview = reviews.find((review) => review.id === delivery.reviewId);
        expect(passedReview).toMatchObject({
          sha: delivery.verificationCommitSha,
          verificationSHA: delivery.verificationCommitSha,
          state: "passed",
          model: "gpt-6.1-sol",
        });
        expect(new Set(reviews.map((review) => review.sessionID)).size).toBe(reviews.length);
        expect(
          reviews.every((review) => ["medium", "high", "xhigh", "max"].includes(review.reasoning)),
        ).toBe(true);
        const [implementationSession] = await database.client<{ id: string }[]>`
          SELECT intent.session_id AS id FROM factory.change_agent_turn_intent intent
          JOIN factory.agent_turn turn ON turn.id=intent.turn_id
          WHERE turn.change_id=${changeID} AND turn.input->>'kind'='change-start'`;
        expect(reviews.every((review) => review.sessionID !== implementationSession?.id)).toBe(
          true,
        );
        const agent = agentViewSchema.parse(await api(`/api/changes/${changeID}/agent`));
        const imageReads = agent.messages.filter(
          (message) =>
            message.activity?.status === "completed" &&
            ((message.activity.name === "browser" && message.text === "screenshot") ||
              (message.text.startsWith("Read /tmp/factory-build-browser-") &&
                message.text.endsWith("/screenshot.jpg"))),
        );
        expect(imageReads.length).toBeGreaterThan(0);
        const sessions = await database.client<
          Array<{ state: string; context: unknown; cleaned: boolean; kind: string }>
        >`
        SELECT browser.state,browser.inspection_context AS context,browser.cleanup_confirmed_at IS NOT NULL AS cleaned,
          turn.input->>'kind' AS kind
        FROM factory.build_browser_session browser JOIN factory.agent_turn turn ON turn.id=browser.turn_id
        WHERE browser.change_id=${changeID}`;
        expect(sessions.some((value) => value.context && value.kind !== "change-review")).toBe(
          true,
        );
        expect(sessions.some((value) => value.context && value.kind === "change-review")).toBe(
          true,
        );
        expect(sessions.every((value) => value.state === "closed" && value.cleaned)).toBe(true);
        const [development] = await database.client<Array<{ id: string }>>`
        SELECT runtime_attempt_id AS id FROM factory.change WHERE id=${changeID}`;
        if (!development) throw new Error("Owned Ticket Workspace is missing");
        await inspectApp(development.id, "development");
        await eventually(
          async () => {
            const rows = await api(`/api/projects/${projectID}/setup`);
            const preview = rows.find((row: { task: string }) => row.task === "main-preview");
            if (preview?.state === "failed")
              throw new Error(`Initial Template Preview failed: ${preview.failure}`);
            return preview;
          },
          (preview) => preview?.state === "ready",
          "Initial Template Preview did not become ready before Delivery",
          remainingJourneyMS(),
        );
        result["initialTemplatePreviewReady"] = true;
        await openTicket();
        await visible(page.getByRole("button", { name: "Deliver", exact: true })).toBeEnabled();
        await captureFactory("05-review-passed");
        const approval = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/changes/${changeID}/delivery/approve`) &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Deliver", exact: true }).click();
        expect((await approval).ok()).toBe(true);
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
          remainingJourneyMS(),
        );
        if (!staging) throw new Error("Owned Staging is missing");
        expect(staging.revision).toBe(delivery.verificationCommitSha);
        await inspectApp(staging.id, "staging");
        await visible(
          page.getByRole("button", { name: "Create follow-up", exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        await captureFactory("06-delivered");
        result["codingStatus"] = "passed";
        result["turns"] = turns;
        result["reviews"] = reviews;
        result["browserSessions"] = sessions;
        result["nativeImageReads"] = imageReads.map(({ id, text }) => ({ id, text }));
        result["outsideSourceEdits"] = 0;
        result["stagingSHA"] = staging.revision;
        // Wiki is an independent background feature, not a Coding prerequisite.
        // Keep its acceptance mandatory, but do not let a Wiki failure erase
        // evidence about the implementation/review/Delivery path.
        if (initialWiki?.state !== "succeeded" || !wiki)
          throw new Error(
            `Initial Wiki acceptance failed: ${initialWiki?.failure ?? "No checked page"}`,
          );
        await eventually(
          async () =>
            database.client<
              { state: string }[]
            >`SELECT state FROM factory.knowledge_generation WHERE project_id=${projectID} AND source_commit_sha=${staging.revision}`,
          (rows) => rows.some((row) => row.state === "succeeded"),
          "Delivered source did not finish its Wiki update",
          remainingJourneyMS(),
        );
        const [retainedNote] = await database.client<
          { body: string; title: string }[]
        >`SELECT current_body AS body,title FROM factory.knowledge_page WHERE id=${wiki.id}`;
        expect(retainedNote?.body).toContain(note);
        if (!retainedNote) throw new Error("The original Wiki page is missing after delivery");
        await page.getByRole("button", { name: "Knowledge", exact: true }).click();
        await page.getByRole("button", { name: retainedNote.title, exact: true }).click();
        await visible(page.getByLabel("Edit Knowledge body", { exact: true })).toContainText(note);
        await captureFactory("07-wiki-note-preserved");
        expect(pageErrors).toEqual([]);
        result["status"] = "passed";
        result["wikiNotePreserved"] = true;
        result["pageErrors"] = pageErrors;
      } catch (cause) {
        result["status"] = "failed";
        result["error"] = cause instanceof Error ? cause.message : "Unknown coding proof failure";
        // Stop changes runtime/turn state and destroys ephemeral execution logs.
        // Preserve secret-free lifecycle evidence before cleanup obscures it.
        if (projectID) {
          result["failureRuntime"] = await database.client`
            SELECT id,workspace_id,state,failure,create_intended_at,create_observed_at,updated_at
            FROM factory.runtime_attempt WHERE project_id=${projectID}`.catch(() => ({
            unavailable: true,
          }));
          result["failureSource"] = await database.client`
            SELECT source.workspace_id,source.access_epoch,source.state,source.failure,
              source.pod_uid,source.claim_uid,source.storage_node,source.updated_at
            FROM factory.workspace_source source
            JOIN factory.development_workspace workspace ON workspace.id=source.workspace_id
            WHERE workspace.project_id=${projectID}`.catch(() => ({ unavailable: true }));
        }
        if (changeID)
          result["failureAgent"] = await api(`/api/changes/${changeID}/agent?history=0`)
            .then((value) => {
              const view = agentViewSchema.parse(value);
              return {
                state: view.state,
                runtimeState: view.runtimeState,
                lastError: view.lastError,
                sessionAvailable: view.sessionAvailable,
                runtimeConnected: view.runtimeConnected,
                stopPending: view.stopPending,
                turn: view.turn,
              };
            })
            .catch(() => ({ unavailable: true }));
        result["implementationBlocker"] = await page
          .getByRole("button", { name: "Implement", exact: true })
          .evaluateAll((buttons) => buttons[0]?.getAttribute("title") ?? null)
          .catch(() => null);
        await page.screenshot({ path: resolve(evidence, "failure.png") }).catch(() => {});
        result["pageErrors"] = pageErrors;
        failure = cause;
      } finally {
        try {
          await browser.close();
          if (!projectID && typeof result["setupID"] === "string") {
            const [intent] = await database.client<{ projectID: string; state: string }[]>`
              SELECT project_id AS "projectID",state FROM factory.project_repository_intent
              WHERE setup_id=${result["setupID"]} AND slug=${slug}`;
            if (!intent || intent.state !== "committed") {
              const cause = new Error(
                "Owned repository setup is still unconfirmed. Its exact intent is retained; execution cleanup cannot yet be confirmed.",
              );
              result["status"] = "failed";
              result["cleanupError"] = cause.message;
              failure ??= cause;
            } else {
              projectID = intent.projectID;
              result["projectID"] = projectID;
            }
          }
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
            if (result["status"] === "passed") {
              const sources = createWorkspaceSourceController(
                database,
                (await readFile(resolve(directory, "auth-secret"), "utf8")).trim(),
              );
              const previousBase = process.env["FACTORY_BASE_URL"];
              process.env["FACTORY_BASE_URL"] = base;
              try {
                await removeOwnedProjectSources(database, projectID, async (workspaceID) => {
                  const [workspace] = await database.client<Array<{ ownerID: string }>>`
                  SELECT COALESCE(workspace.owner_user_id,project.created_by) AS "ownerID"
                  FROM factory.development_workspace workspace
                  JOIN factory.project project ON project.id=workspace.project_id
                  WHERE workspace.id=${workspaceID} AND workspace.project_id=${projectID}`;
                  if (!workspace) throw new Error("Owned coding source identity disappeared");
                  return sources.stop(workspaceID, workspace.ownerID);
                });
                result["ownedSourceStorageRemoved"] = true;
              } finally {
                try {
                  await sources.close();
                } finally {
                  if (previousBase === undefined) delete process.env["FACTORY_BASE_URL"];
                  else process.env["FACTORY_BASE_URL"] = previousBase;
                }
              }
            }
          }
          result["ownedExecutionStopped"] = !result["cleanupError"];
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
