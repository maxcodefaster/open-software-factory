import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { z } from "zod";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { ownedRuntimeTerminal, runtimeAccessCookie } from "../fixtures/runtime-access";
import { callFactoryFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const userID = "01994a7d-0000-7000-8000-000000000001";
const runtimeProbe = process.env["FACTORY_BROWSER_RUNTIME_PROBE"] === "1";

test.skipIf(process.env["FACTORY_LIVE_BROWSER_BUILD"] !== "1" && !runtimeProbe)(
  runtimeProbe
    ? "controlled OpenCode browser tools work in actual Envbox and Stop cleans their state"
    : "real OpenCode inspects and repairs an App overlap through isolated browser tools before exact Verification",
  async () => {
    const modelId = process.env["FACTORY_AGENT_MODEL_ID"];
    const providerURL = process.env["FACTORY_MODEL_BASE_URL"];
    const providerKey = process.env["FACTORY_MODEL_API_KEY"];
    if (!modelId || !providerURL || !providerKey)
      throw new Error("Browser Build needs the configured deployed model");
    const runtimeHostImage = (await readFile(".factory/runtime-host-image", "utf8")).trim();
    const browserToolsImage = (await readFile(".factory/browser-tools-image", "utf8")).trim();
    const forgejoToken = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const projectID = crypto.randomUUID();
    const ticketID = crypto.randomUUID();
    const slug = `browser-build-${projectID.slice(0, 8)}`;
    const directory = `.factory/test-results/browser-tools/${slug}`;
    await mkdir(directory, { recursive: true });
    const images = new Set<string>();
    const observations = {
      requests: 0,
      model: modelId,
      snapshot: false,
      console: false,
      checkout: false,
    };
    const browserDiagnostics: string[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        try {
          const suffix = new URL(request.url).pathname.replace(/^\/v1\//, "");
          if (!["chat/completions", "responses"].includes(suffix))
            return new Response(null, { status: 404 });
          const body: unknown = await request.json();
          const text = JSON.stringify(body);
          observations.requests++;
          observations.snapshot ||= text.includes("Delivery dashboard") && text.includes("uid=");
          observations.console ||= text.includes("browser-defect-fixture-ready");
          observations.checkout ||=
            text.includes("Factory observation: turn=") ||
            (text.includes("headCommit") && text.includes("runtimeAttemptId"));
          // Retain only recognized integration failures, never arbitrary tool output.
          for (const error of [
            "browser container operation was not confirmed",
            "browser create outcome could not be recovered",
            "Factory Build browser configuration is unavailable",
            "Browser inspection was not confirmed",
            "browser operation does not match its admitted execution scope",
            "browser execution lease is expired or exceeds its bound",
            "browser control connection ended",
            "browser session does not belong to the active execution owner",
            "browser session requires owned cleanup after parent restart",
            "browser session already ended",
            "Browser no longer owns this Build execution",
            "Browser execution authority is expiring",
            "Browser requires live Build authority",
            "Browser Build authority changed before dispatch",
            "Browser returned an invalid observation schema",
            "browser primary container inspection was not confirmed",
            "browser primary container no longer owns this Workspace generation",
            "browser container did not retain its exact isolation boundary",
            "browser create outcome could not be recovered by its persisted identity",
            "browser socket/configuration directory unavailable",
            "browser socket directory ownership unavailable",
            "browser App proxy startup exceeded its authority",
            "browser App proxy did not become ready within five seconds",
            "browser tool process failed to start",
            "browser tool outcome is unavailable",
            "browser tool exceeded its execution authority or deadline",
            "browser execution authority ended",
            "browser MCP did not report the pinned upstream version",
            "Browser observation does not match this execution scope",
            "browser App page identity unavailable",
            "browser did not retain the declared App page identity",
            "browser observation exceeds its bounds or has unsupported content",
            "browser checkout context is unavailable",
            "browser checkout mount does not match the assigned shared workspace",
            "browser checkout HEAD could not be established",
            "browser checkout modification state is unavailable",
            "browser screenshot publication was not confirmed",
            "net::ERR_",
            "net::ERR_CONNECTION_REFUSED",
            "net::ERR_PROXY_CONNECTION_FAILED",
            "net::ERR_CONNECTION_RESET",
            "net::ERR_NAME_NOT_RESOLVED",
            "net::ERR_TIMED_OUT",
            "No usable sandbox",
            "Failed to launch",
            "Target closed",
            "Navigation timeout",
            "Permission denied",
            "not found",
            "No active Build browser authority",
          ]) {
            if (text.includes(error) && !browserDiagnostics.includes(error))
              browserDiagnostics.push(error);
          }
          // The observer forwards unchanged. Only bounded fixture JPEGs and presence
          // counters are retained, never provider tokens or raw inference bodies.
          async function inspect(value: unknown): Promise<void> {
            if (typeof value === "string" && value.startsWith("data:image/jpeg;base64,")) {
              const data = Buffer.from(value.slice("data:image/jpeg;base64,".length), "base64");
              if (data.length > 2 << 20)
                throw new Error("Fixture image exceeds the screenshot bound");
              const digest = createHash("sha256").update(data).digest("hex");
              if (!images.has(digest) && images.size < 8) {
                images.add(digest);
                await writeFile(`${directory}/model-image-${images.size}.jpg`, data);
              }
            } else if (Array.isArray(value)) await Promise.all(value.map(inspect));
            else if (value && typeof value === "object")
              await Promise.all(Object.values(value).map(inspect));
          }
          await inspect(body);
          if (runtimeProbe) {
            const turn = /Current Build turn: ([a-f0-9-]{36})/.exec(text)?.[1];
            if (!turn)
              return Response.json(
                { error: "Probe requires the admitted browser instruction" },
                { status: 400 },
              );
            const calls = [
              { name: "browser_open", arguments: { app: "app" } },
              { name: "browser_snapshot", arguments: {} },
              { name: "browser_console", arguments: {} },
              { name: "browser_screenshot", arguments: {} },
            ];
            const call = calls[observations.requests - 1];
            const tool = call
              ? {
                  name: `factory_browser_${call.name}`,
                  arguments: JSON.stringify(call.arguments),
                }
              : undefined;
            if (!tool) {
              if (images.size > 0)
                await new Promise<void>((resolve) => {
                  if (request.signal.aborted) resolve();
                  else request.signal.addEventListener("abort", () => resolve(), { once: true });
                });
              else
                return Response.json(
                  {
                    error: `Controlled browser probe failed: ${browserDiagnostics.join(", ") || "no screenshot path returned"}`,
                  },
                  { status: 400 },
                );
            }
            const delta = tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_browser_probe_${observations.requests}`,
                      type: "function",
                      function: tool,
                    },
                  ],
                }
              : { content: "Owned browser probe stopped" };
            return new Response(
              `data: ${JSON.stringify({
                id: "chatcmpl_browser_probe",
                object: "chat.completion.chunk",
                created: 1,
                model: modelId,
                choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }],
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return await fetch(`${providerURL.replace(/\/$/, "")}/${suffix}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${providerKey}` },
            body: text,
            redirect: "error",
            signal: request.signal,
          });
        } catch {
          // A fixture HTTP failure must let the admitted turn fail normally so
          // the test's owned-runtime cleanup still runs. Never expose its body.
          return Response.json(
            { error: "Browser proof provider observation failed" },
            { status: 502 },
          );
        }
      },
    });
    let fixture: Awaited<ReturnType<typeof factoryProcess>>;
    try {
      fixture = await factoryProcess(
        { runtimeHostImage, forgejoToken },
        {
          FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
          FACTORY_BROWSER_TOOLS_IMAGE: browserToolsImage,
        },
      );
    } catch (cause) {
      await provider.stop(true);
      throw cause;
    }
    const database = fixture.connect();
    const forge = createForgejoClient({
      apiURL: "http://127.0.0.1:33030/api/v1/",
      token: forgejoToken,
    });
    let cookie = "";
    let terminal: Awaited<ReturnType<typeof ownedRuntimeTerminal>> | undefined;
    let safeToDispose = false;
    let changeID = "";
    let attemptID = "";
    let baseSHA = "";
    async function request(path: string, method = "GET", body?: unknown, auth = cookie) {
      return fetch(`${fixture.base}${path}`, {
        method,
        headers: { cookie: auth, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(90_000),
      });
    }
    async function command(path: string, body: unknown = {}, method = "POST", auth = cookie) {
      const result = await request(path, method, body, auth);
      if (!result.ok) throw new Error(`Browser Build command ${path} failed: ${result.status}`);
      return result;
    }
    async function visual(label: string) {
      const accessCookie = await runtimeAccessCookie(fixture.base, cookie, attemptID, "app");
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const [name, value] = accessCookie.split(";")[0]?.split("=") ?? [];
        if (!name || !value) throw new Error("Fixture App grant missing");
        await context.addCookies([{ name, value, url: fixture.base }]);
        const page = await context.newPage();
        await page.goto(`${fixture.base}/runtime/${attemptID}/app/`);
        const heading = page.getByRole("heading", { name: "Delivery dashboard" });
        const action = page.getByRole("button", { name: "Continue", exact: true });
        await heading.waitFor();
        await action.waitFor();
        const a = await heading.boundingBox();
        const b = await action.boundingBox();
        if (!a || !b) throw new Error("Fixture bounds unavailable");
        await page.screenshot({ path: `${directory}/${label}.png` });
        return {
          heading: a,
          action: b,
          overlaps:
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height,
        };
      } finally {
        await browser.close();
      }
    }
    try {
      await fixture.start();
      cookie = await fixture.signIn();
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "saveModelSettings",
          [{ version: 0, planningModelId: modelId, buildModelId: modelId }],
          { cookie },
        ),
      );
      baseSHA = (await forge.getDefaultBranch(repository)).headSha;
      await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${projectID}, ${slug}, 'Browser-assisted UI repair', 'http://127.0.0.1:33030/factory-mutation/runtime-fixture.git', 'main', '.devcontainer/devcontainer.json', ${userID})`;
      const zero = zeroDrizzle(zeroSchema, database.db);
      await zero.transaction(async (tx) =>
        zeroServerMutators.tickets.create.fn({
          tx,
          ctx: { userId: userID, systemManager: true },
          args: {
            id: ticketID,
            projectId: projectID,
            title: "Fix overlapping Continue action",
            description: "Inspect and repair the declared development App.",
          },
        }),
      );
      const revision = z.object({ id: z.uuid() }).parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "createRequirementRevision",
            [
              ticketID,
              {
                summary:
                  "Fix the Continue button overlapping Delivery dashboard in src/browser-page.html. The manual fixture template reader in src/server.mjs is intentional and must be retained.",
                acceptanceCriteria: [
                  "Before editing, use the native Factory browser tools to open declared App app, inspect its DOM and console, capture a screenshot and inspect the returned image. Reproduce the overlap visually.",
                  "Continue is in normal document flow below Delivery dashboard, not positioned over the heading. Edit only src/browser-page.html; keep the page readable and the fixture template reader intact.",
                  "After editing, use browser_open again on App app, inspect DOM and console, capture and read a second screenshot. Describe the finding with the returned turn/App/checkout context. No scripts or arbitrary URLs in browser tools.",
                  "node --check src/server.mjs passes. Do not restart the App: the fixture reads browser-page.html on each HTTP request.",
                ],
                nonGoals: [
                  "Dependencies, runtime configuration, changing version.txt, other file edits, browser scripts or host tooling",
                ],
              },
            ],
            { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
            AbortSignal.timeout(90_000),
          ),
        ),
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "approveRequirementRevision",
          [ticketID, revision.id],
          { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "startTicketChange",
          [ticketID],
          { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const change = await eventually(
        async () => {
          const [row] = await database.client<
            Array<{ id: string; state: string }>
          >`SELECT id, state FROM factory.change WHERE ticket_id = ${ticketID}`;
          if (row?.state === "failed") throw new Error("Owned Change failed before Browser Build");
          return row;
        },
        (row) => row?.state === "active",
        "Owned Change branch not ready",
        60_000,
      );
      if (!change) throw new Error("Owned Change missing");
      changeID = change.id;
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "startTicketWorkspace",
          [changeID],
          { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const runtime = await eventually(
        async () => {
          const [row] = await database.client<
            Array<{ id: string; state: string; failure: string | null }>
          >`
          SELECT attempt.id, attempt.state, attempt.failure FROM factory.change change
          JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id WHERE change.id = ${changeID}`;
          if (row?.state === "failed")
            throw new Error(`Owned Workspace failed: ${row.failure?.slice(0, 300)}`);
          return row;
        },
        (row) => row?.state === "ready",
        "Owned Ticket Workspace not ready",
        300_000,
      );
      if (!runtime) throw new Error("Owned runtime missing");
      attemptID = runtime.id;
      terminal = await ownedRuntimeTerminal(fixture.base, cookie, attemptID);
      const page =
        '<section><h1>Delivery dashboard</h1><button style="position:absolute;top:8px;left:8px">Continue</button><p>Review this release before delivery.</p></section><script>console.log("browser-defect-fixture-ready")</script>';
      await terminal.evaluate(
        `const fs=require("node:fs"); const file="src/server.mjs"; const source=fs.readFileSync(file,"utf8"); if(!source.includes("<h1>Runtime fixture ready</h1>"))throw new Error("Expected fixture template not found"); fs.writeFileSync(file,source.replace("<h1>Runtime fixture ready</h1>", '\${await readFile(new URL("./browser-page.html", import.meta.url), "utf8")}')); fs.writeFileSync("src/browser-page.html",${JSON.stringify(page)}); return true;`,
      );
      await command(
        `/runtime/${attemptID}/ide/__factory/processes/app/restart`,
        {},
        "POST",
        terminal.runtimeCookie,
      );
      const before = await visual("before");
      expect(before.overlaps).toBe(true);
      console.info("Browser Build: real App overlap reproduced; starting configured OpenCode");
      const commandID = crypto.randomUUID();
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "startCoding",
          [changeID, { commandId: commandID }],
          { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      if (runtimeProbe) {
        await eventually(
          async () => {
            const [turn] = await database.client<
              Array<{ state: string }>
            >`SELECT state FROM factory.agent_turn WHERE command_id = ${commandID}`;
            if (turn && ["failed", "completed", "stopped"].includes(turn.state))
              throw new Error(
                `Browser runtime probe ended ${turn.state}: ${browserDiagnostics.join(", ") || "no confirmed image observation"}`,
              );
            return images.size;
          },
          (count) => count >= 1,
          "Actual Envbox browser transport did not produce an image",
          120_000,
        );
        expect(observations).toMatchObject({ snapshot: true, console: true, checkout: true });
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "stopCoding",
            [changeID],
            { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
            AbortSignal.timeout(90_000),
          ),
        );
        const sessions = await database.client<
          Array<{ id: string; state: string; context: unknown; confirmed: boolean }>
        >`
          SELECT id, state, inspection_context AS context, cleanup_confirmed_at IS NOT NULL AS confirmed
          FROM factory.build_browser_session WHERE change_id = ${changeID}`;
        expect(sessions.length).toBeGreaterThan(0);
        expect(
          sessions.every(
            (session) => session.state === "closed" && session.confirmed && session.context,
          ),
        ).toBe(true);
        await writeFile(
          `${directory}/runtime-probe.json`,
          JSON.stringify(
            {
              projectID,
              changeID,
              attemptID,
              observations,
              sessions,
              browserDiagnostics,
              imageCount: images.size,
            },
            null,
            2,
          ),
        );
        return;
      }
      const verification = await eventually(
        async () => {
          const [row] = await database.client<
            Array<{ id: string; state: string; sha: string; runtimeRevision: string }>
          >`
          SELECT verification.id, verification.state, verification.commit_sha AS sha, attempt.revision AS "runtimeRevision"
          FROM factory.verification verification JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
          WHERE verification.change_id = ${changeID} ORDER BY verification.created_at DESC LIMIT 1`;
          const [turn] = await database.client<
            Array<{ state: string; summary: string | null }>
          >`SELECT state, outcome_summary AS summary FROM factory.agent_turn WHERE command_id = ${commandID}`;
          if (turn && ["failed", "stopped"].includes(turn.state))
            throw new Error(
              `Real browser Build ended ${turn.state}: ${turn.summary?.slice(0, 300)}`,
            );
          return row;
        },
        (row) => row?.state === "succeeded",
        "Real browser-assisted repair did not pass Verification",
        600_000,
      );
      if (!verification) throw new Error("Owned Verification missing");
      expect(verification.runtimeRevision).toBe(verification.sha);
      const after = await visual("after");
      expect(after.overlaps).toBe(false);
      expect(images.size).toBeGreaterThanOrEqual(2);
      expect(observations).toMatchObject({ snapshot: true, console: true, checkout: true });
      const sessions = await database.client<
        Array<{
          id: string;
          state: string;
          context: {
            headCommit: string;
            app: string;
            turnId: string;
            workingTreeModified: boolean;
          };
          confirmed: boolean;
        }>
      >`
        SELECT id, state, inspection_context AS context, cleanup_confirmed_at IS NOT NULL AS confirmed
        FROM factory.build_browser_session WHERE change_id = ${changeID}`;
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((session) => session.state === "closed" && session.confirmed)).toBe(
        true,
      );
      expect(
        sessions.some(
          (session) =>
            session.context?.headCommit === baseSHA &&
            session.context.app === "app" &&
            session.context.workingTreeModified,
        ),
      ).toBe(true);
      for (const session of sessions)
        expect(
          await terminal.evaluate<boolean>(
            `return !require("node:fs").existsSync(${JSON.stringify(`/tmp/factory-build-browser-${session.id}`)});`,
          ),
        ).toBe(true);
      const fixed = await forge.getFile(repository, "src/browser-page.html", verification.sha);
      expect(fixed).toContain("Continue");
      expect(fixed).not.toContain("position:absolute");
      await writeFile(
        `${directory}/verified.json`,
        JSON.stringify(
          {
            projectID,
            ticketID,
            changeID,
            attemptID,
            baseSHA,
            verification,
            before,
            after,
            observations,
            modelImages: images.size,
            browserDiagnostics,
            sessions,
            runtimeHostImage,
            browserToolsImage,
          },
          null,
          2,
        ),
      );
      console.info(
        "Browser Build: two genuine model image observations, corrected layout and exact Verification passed",
      );
    } catch (cause) {
      const attempts =
        await database.client`SELECT id, state, failure FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
      const turns =
        await database.client`SELECT id, state, outcome_summary FROM factory.agent_turn WHERE project_id = ${projectID}`;
      await writeFile(
        `${directory}/failure.json`,
        JSON.stringify(
          {
            error: cause instanceof Error ? cause.message : "Unknown failure",
            attempts,
            turns,
            observations,
            modelImages: images.size,
          },
          null,
          2,
        ),
      );
      throw cause;
    } finally {
      terminal?.close();
      try {
        const cleanOwnedResources = async () => {
          if (cookie) {
            const changes = await database.client<
              Array<{ id: string; branch: string; base: string }>
            >`SELECT id, branch_name AS branch, base_sha AS base FROM factory.change WHERE project_id = ${projectID}`;
            for (const change of changes) {
              await serverCall(
                callFactoryFunction(
                  fixture.base,
                  "stopCoding",
                  [change.id],
                  { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
                  AbortSignal.timeout(90_000),
                ),
              );
              await serverCall(
                callFactoryFunction(
                  fixture.base,
                  "cancelChange",
                  [change.id],
                  { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
                  AbortSignal.timeout(90_000),
                ),
              );
            }
            await eventually(
              async () => {
                const attempts = await database.client<
                  Array<{ id: string }>
                >`SELECT id FROM factory.runtime_attempt WHERE project_id = ${projectID} AND state <> 'stopped'`;
                for (const attempt of attempts)
                  await serverCall(
                    callFactoryFunction(
                      fixture.base,
                      "stopRuntimeAttempt",
                      [attempt.id],
                      { cookie: cookie, origin: fixture.base, "content-type": "application/json" },
                      AbortSignal.timeout(90_000),
                    ),
                  );
                const child = Bun.spawn(
                  [
                    "kubectl",
                    "--context",
                    "orbstack",
                    "get",
                    "namespaces",
                    "-l",
                    `factory.dev/project=${projectID}`,
                    "-o",
                    "json",
                  ],
                  { stdout: "pipe", stderr: "ignore" },
                );
                const output = await new Response(child.stdout).text();
                if ((await child.exited) !== 0)
                  throw new Error("Owned namespace cleanup observation unavailable");
                return (
                  attempts.length +
                  z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(output)).items.length
                );
              },
              (count) => count === 0,
              "Owned Browser Build runtimes not cleaned",
              180_000,
            );
            for (const change of changes) {
              const pull = await forge.getPullRequest(repository, "main", change.branch);
              const [commit] = await database.client<
                Array<{ sha: string }>
              >`SELECT commit_sha AS sha FROM factory.change_commit_operation WHERE change_id = ${change.id} AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1`;
              if (pull && !pull.merged && pull.state === "open") {
                if (pull.headSha !== commit?.sha)
                  throw new Error("Owned PR cleanup refused unexpected head");
                const closed = await fetch(
                  `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/pulls/${pull.number}`,
                  {
                    method: "PATCH",
                    headers: {
                      authorization: `token ${forgejoToken}`,
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({ state: "closed" }),
                  },
                );
                if (!closed.ok) throw new Error("Owned PR cleanup failed");
              }
              const branch = await forge.getBranch(repository, change.branch);
              if (branch) {
                if (![change.base, commit?.sha].includes(branch.headSha))
                  throw new Error("Owned branch cleanup refused unexpected head");
                await forge.deleteBranch(repository, change.branch);
              }
            }
            expect((await forge.getDefaultBranch(repository)).headSha).toBe(baseSHA);
          }
          safeToDispose = true;
          await writeFile(
            `${directory}/cleanup.json`,
            JSON.stringify({
              ownedRuntimesRemoved: true,
              ownedBranchRemoved: true,
              defaultBranchUnchanged: true,
              unrelatedRuntimesUntouched: true,
            }),
          );
        };
        await cleanOwnedResources();
      } finally {
        await database.client.end();
        try {
          if (safeToDispose) await fixture.dispose();
          else await fixture.shutdown();
        } finally {
          await provider.stop(true);
        }
      }
    }
  },
  1_200_000,
);
