import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, type WebSocketRoute } from "@playwright/test";
import { z } from "zod";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { ownedBrowserEnvironment } from "../fixtures/owned-browser-run";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserFunction } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";

test("Zero drives shared reads without idle polling, preserves drafts through recovery, and fences revoked readers", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const evidence = resolve(".factory/test-results/zero-adoption");
  const previousBuild = process.env["FACTORY_BUILD_DIRECTORY"];
  const environment = await ownedBrowserEnvironment();
  const build = environment.FACTORY_BUILD_DIRECTORY;
  await mkdir(evidence, { recursive: true });
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/inbox-browser-host.ts"],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const stopped = new Promise<void>((resolve) => host.once("exit", () => resolve()));
  let database: ReturnType<typeof createDatabase> | undefined;
  const colleagueContext = await browser.newContext();
  try {
    const fixture = await new Promise<{ fixtureBase: string; id: string; databaseURL: string }>(
      (resolve, reject) => {
        createInterface({ input: host.stdout }).on("line", (line) => {
          if (line.startsWith("Owned ")) console.info(line);
          if (line.startsWith('{"fixtureBase"')) resolve(JSON.parse(line));
        });
        host.once("exit", () =>
          reject(new Error(`Owned Zero host exited: ${stderr.slice(-2000)}`)),
        );
      },
    );
    const previous = process.env["DATABASE_URL"];
    process.env["FACTORY_BUILD_DIRECTORY"] = build;
    process.env["DATABASE_URL"] = fixture.databaseURL;
    database = createDatabase(2);
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket("**/*", (route) => {
      socket = route;
      const upstream = route.connectToServer();
      route.onMessage((message) => upstream.send(message));
      upstream.onMessage((message) => route.send(message));
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(fixture.fixtureBase);
    await page.getByLabel("Email", { exact: true }).fill(`owned-${fixture.id}@factory.local`);
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const [administrator] = await database.client<
      { id: string }[]
    >`SELECT user_id AS id FROM factory.administrator`;
    const project = crypto.randomUUID(),
      ticket = crypto.randomUUID(),
      conversation = crypto.randomUUID();
    const oldTicket = "00000100-0000-4000-8000-000000000000";
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`zero-${project}`},'Shared Zero proof','https://example.invalid/owned-zero.git','main','.devcontainer/devcontainer.json',${fixtureValue(administrator, "administrator").id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${project},${fixtureValue(administrator, "administrator").id},'developer',${fixtureValue(administrator, "administrator").id})`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${ticket},${project},'Shared invoice flow','ready',${fixtureValue(administrator, "administrator").id})`;
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
      VALUES(${conversation},${project},${ticket},'plan',${fixtureValue(administrator, "administrator").id})`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by,updated_at)
      SELECT gen_random_uuid(),${project},'Completed history '||value,'done',${fixtureValue(administrator, "administrator").id},now()
      FROM generate_series(1,52) AS value`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by,updated_at)
      VALUES(${oldTicket},${project},'Old invoice reference','done',${fixtureValue(administrator, "administrator").id},'2000-01-01'::timestamptz)`;
    const epic = crypto.randomUUID();
    await database.client`INSERT INTO factory.epic(id,project_id,title,description,created_by)
      VALUES(${epic},${project},'Older invoice work','Retained history',${fixtureValue(administrator, "administrator").id})`;
    await database.client`UPDATE factory.ticket SET epic_id=${epic},version=version+1 WHERE id=${oldTicket}`;
    await expect(page.getByRole("button", { name: "Open project menu", exact: true })).toHaveText(
      "Shared Zero proof",
    );
    await expect(
      page.locator(".ticket-card-body").filter({ hasText: "Shared invoice flow" }),
    ).toBeVisible();
    await expect(page.getByRole("status", { name: "Shared work sync" })).toHaveCount(0);
    const counts: Record<string, number> = {};
    page.on("request", (request) => {
      const name = new URL(request.url()).pathname.match(
        /^\/_server\/data\/(.+)-[a-zA-Z0-9_-]+$/,
      )?.[1];
      if (name) counts[name] = (counts[name] ?? 0) + 1;
    });
    await page.waitForTimeout(1000);
    for (const key of Object.keys(counts)) delete counts[key];
    await page.waitForTimeout(6100);
    await writeFile(
      `${evidence}/browser-idle-requests.json`,
      JSON.stringify({ idleWindowMs: 6100, counts }, null, 2),
    );
    expect(counts).toEqual({});

    const email = `${crypto.randomUUID()}@zero.test`,
      password = "owned-browser-password-not-a-secret";
    const member = z
      .object({ id: z.uuid() })
      .parse(
        await serverCall(
          browserFunction(page, "createAccount", [{ name: "Owned colleague", email, password }]),
        ),
      );
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${project},${member.id},'product-contributor',${fixtureValue(administrator, "administrator").id})`;
    const colleague = await colleagueContext.newPage();
    colleague.on("pageerror", (error) => errors.push(error.message));
    const frames: string[] = [];
    colleague.on("websocket", (connection) => {
      connection.on("framereceived", (frame) =>
        frames.push(
          typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"),
        ),
      );
    });
    await colleague.goto(fixture.fixtureBase);
    await colleague.getByLabel("Email", { exact: true }).fill(email);
    await colleague.getByLabel("Password", { exact: true }).fill(password);
    await colleague.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      colleague.locator(".ticket-card-body").filter({ hasText: "Shared invoice flow" }),
    ).toBeVisible();
    await colleague.locator(".ticket-card-body").filter({ hasText: "Shared invoice flow" }).click();
    const question = crypto.randomUUID();
    await database.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
      VALUES(${question},${conversation},1,'question','project-agent','plan','Which invoice state?',
        '{"question":{"type":"free-text","prompt":"Which invoice state?","placeholder":"Describe the state"}}'::jsonb)`;
    await expect(
      colleague.getByRole("button", { name: "Inbox, 1 items need your attention" }),
    ).toBeVisible();
    await colleague.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await expect(colleague.locator(`#conversation-entry-${question}`)).toContainText(
      "Which invoice state?",
    );
    const panelReads: string[] = [];
    colleague.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        /\/_server\/data\/get(?:Conversation|TicketDetail|Inbox|Changes|RuntimeAttempts|ProjectPreviews|TicketAttention)-/.test(
          path,
        )
      )
        panelReads.push(path);
    });
    await colleague.waitForTimeout(1000);
    panelReads.length = 0;
    await colleague.waitForTimeout(2100);
    expect(panelReads).toEqual([]);
    await database.client`UPDATE factory.ticket SET title='Invoice flow updated elsewhere',version=version+1 WHERE id=${ticket}`;
    await expect(colleague.getByLabel("Ticket title", { exact: true })).toContainText(
      "Invoice flow updated elsewhere",
    );
    await expect(
      page.locator(".ticket-card-body").filter({ hasText: "Invoice flow updated elsewhere" }),
    ).toBeVisible();
    await colleague.getByRole("button", { name: "Knowledge", exact: true }).click();
    await expect(
      colleague.getByRole("button", { name: "Create Project Wiki", exact: true }),
    ).toBeEnabled();
    expect(await database.client`SELECT id FROM factory.knowledge_generation`).toHaveLength(0);
    const wikiA = crypto.randomUUID(),
      wikiB = crypto.randomUUID();
    for (const [id, title, body, slug] of [
      [wikiA, "A invoice overview", "Selected Wiki body Alpha", "overview"],
      [wikiB, "B invoice workflow", "Unopened Wiki body Bravo", "workflow"],
    ] as const)
      await database.client`INSERT INTO factory.knowledge_page
        (id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
        VALUES(${id},${project},${slug},${title},${body},${body},${"a".repeat(40)},${fixtureValue(administrator, "administrator").id})`;
    await expect(colleague.getByText("Selected Wiki body Alpha", { exact: true })).toBeVisible();
    expect(frames.join("")).toContain("Selected Wiki body Alpha");
    expect(frames.join("")).not.toContain("Unopened Wiki body Bravo");
    await colleague.getByRole("button", { name: "B invoice workflow", exact: true }).click();
    await expect(colleague.getByText("Unopened Wiki body Bravo", { exact: true })).toBeVisible();
    await database.client`UPDATE factory.knowledge_page
      SET title='A invoice overview revised',current_body='Inactive Wiki update stays out of sync',version=version+1
      WHERE id=${wikiA}`;
    await expect(
      colleague.getByRole("button", { name: "A invoice overview revised", exact: true }),
    ).toBeVisible();
    expect(frames.join("")).not.toContain("Inactive Wiki update stays out of sync");
    await colleague.getByRole("button", { name: "Close Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Open Epic Older invoice work", exact: true }).click();
    const folder = page.getByRole("dialog", { name: "Older invoice work", exact: true });
    await expect(folder).toContainText("No Tickets in the loaded pages");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `${evidence}/partial-epic-390.png`,
      fullPage: true,
      animations: "disabled",
    });
    await folder.getByRole("button", { name: "Show more Tickets", exact: true }).click();
    await expect(
      folder.getByRole("button").filter({ hasText: "Old invoice reference" }),
    ).toBeVisible();
    await folder.getByRole("button", { name: "Close Epic", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload();
    await expect(page.getByRole("button", { name: /^History 50\+/ })).toBeVisible();

    await page.getByRole("button", { name: "Find Ticket", exact: true }).click();
    const find = page.getByRole("dialog", { name: "Find Ticket" });
    await find.getByRole("searchbox").fill("TCK-000001");
    await expect(
      find.getByRole("button").filter({ hasText: "Old invoice reference" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^History/ }).click();
    await expect(
      page.getByRole("button", { name: "Show more completed Tickets", exact: true }),
    ).toBeVisible();
    const archive = page.getByRole("region", { name: "history", exact: true });
    await expect(archive.getByRole("button")).toHaveCount(50);
    await expect(page.locator(".board-history")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `${evidence}/bounded-history-1440.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Show more completed Tickets", exact: true }).click();
    await expect(
      page.getByRole("button").filter({ hasText: "Old invoice reference" }),
    ).toBeVisible();
    await expect(archive.getByRole("button")).toHaveCount(53);
    expect(
      await page
        .locator(".board-history")
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    await archive
      .getByRole("button")
      .filter({ hasText: "Old invoice reference" })
      .scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 390, height: 844 });
    await archive
      .getByRole("button")
      .filter({ hasText: "Old invoice reference" })
      .scrollIntoViewIfNeeded();
    await expect(
      archive.getByRole("button").filter({ hasText: "Old invoice reference" }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `${evidence}/bounded-history-390.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "Active work", exact: true }).click();

    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await page.getByLabel("Ticket title", { exact: true }).fill("Retain my uncreated draft");
    expect(socket).toBeDefined();
    const sync = page.getByRole("status", { name: "Shared work sync" });
    const originalDocument = await page.evaluate(() => performance.timeOrigin);
    for (const [width, failure] of [
      [1440, { reason: "internal", message: "Fetch from API server threw error: fetch failed" }],
      [
        390,
        {
          reason: "http",
          status: 503,
          message: "Fetch from API server returned non-OK status 503",
        },
      ],
    ] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      fixtureValue(socket, "socket").send(
        JSON.stringify([
          "error",
          { kind: "TransformFailed", origin: "zeroCache", queryIDs: [], ...failure },
        ]),
      );
      await expect(sync).toContainText("Reconnecting to shared updates");
      await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
        "Retain my uncreated draft",
      );
      await page.screenshot({
        path: `${evidence}/sync-api-reconnecting-${width}.png`,
        fullPage: true,
      });
      const noticeBox = await sync.boundingBox();
      const titleBox = await page.getByLabel("Ticket title", { exact: true }).boundingBox();
      expect(noticeBox).not.toBeNull();
      expect(titleBox).not.toBeNull();
      expect(
        fixtureValue(noticeBox, "noticeBox").y + fixtureValue(noticeBox, "noticeBox").height,
      ).toBeLessThanOrEqual(fixtureValue(titleBox, "titleBox").y);
      await expect(sync).toHaveCount(0, { timeout: 15_000 });
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalDocument);
      await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
        "Retain my uncreated draft",
      );
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    fixtureValue(socket, "socket").send(
      JSON.stringify([
        "error",
        { kind: "Internal", origin: "zeroCache", message: "Owned sync failure" },
      ]),
    );
    await expect(sync).toContainText("Shared updates stopped");
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
      "Retain my uncreated draft",
    );
    await page.screenshot({ path: `${evidence}/sync-error-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${evidence}/sync-error-390.png`, fullPage: true });
    await sync.getByRole("button", { name: "Retry sync", exact: true }).click();
    await expect(sync).toHaveCount(0);
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
      "Retain my uncreated draft",
    );
    fixtureValue(socket, "socket").send(
      JSON.stringify([
        "error",
        { kind: "Unauthorized", origin: "zeroCache", message: "Owned expired session" },
      ]),
    );
    await expect(sync).toContainText("Your session expired");
    await expect(sync.getByRole("button", { name: "Sign in again", exact: true })).toBeEnabled();
    await page.screenshot({ path: `${evidence}/sync-auth-390.png`, fullPage: true });
    await sync.getByRole("button", { name: "Sign in again", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
      "Retain my uncreated draft",
    );

    await database.client`DELETE FROM factory.project_membership WHERE project_id=${project} AND user_id=${member.id}`;
    await expect(
      colleague.getByRole("article", { name: "Ticket document", exact: true }),
    ).toHaveCount(0);
    await openProjectMenu(colleague);
    await expect(colleague.getByRole("button").filter({ hasText: `zero-${project}` })).toHaveCount(
      0,
    );
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    expect(await database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(await database.client`SELECT id FROM factory.delivery_approval`).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.ticket WHERE title='Retain my uncreated draft'`,
    ).toHaveLength(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${evidence}/recovered-draft-390.png`, fullPage: true });
    expect(errors).toEqual([]);
  } catch (cause) {
    console.error("Owned Zero browser proof failed", cause);
    throw cause;
  } finally {
    try {
      await colleagueContext.close();
    } finally {
      try {
        await database?.client.end();
      } finally {
        host.kill("SIGTERM");
        await stopped;
        if (previousBuild === undefined) delete process.env["FACTORY_BUILD_DIRECTORY"];
        else process.env["FACTORY_BUILD_DIRECTORY"] = previousBuild;
      }
    }
  }
});
