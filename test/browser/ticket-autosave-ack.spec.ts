import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { createDatabase } from "#db/client";
import { CommandError } from "../../apps/factory/src/command-error";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  browserBootstrap,
  browserFunction,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test.describe("local Ticket hydration", () => {
  let server: ViteDevServer;
  let origin: string;
  const cache = resolve(".factory/test-results/vite", `ticket-hydration-${crypto.randomUUID()}`);
  const moduleID = resolve("test/fixtures/ticket-hydration.tsx");
  // Render the real Ticket owner with independently arriving saved revisions. Keeping the
  // module local to this regression avoids a Factory build, database, or runtime fixture.
  const source = `
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { TicketWorkspace } from "../../apps/factory/src/tickets/ticket-workspace";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

function Surface() {
  const ticketID = "10000000-0000-4000-8000-000000000002";
  const revisionID = "10000000-0000-4000-8000-000000000003";
  const approvalID = "10000000-0000-4000-8000-000000000004";
  const drafts = new Map();
  const [open, setOpen] = createSignal(false);
  const [version, setVersion] = createSignal(3);
  const [writes, setWrites] = createSignal([]);
  const [work, setWork] = createSignal(0);
  const original = { summary: "Old manual specification. Do not implement this fixture.",
    acceptanceCriteria: ["Keep the existing approved scope."], nonGoals: [] };
  const fresh = { ...original, summary: "Fresh manual specification without fixture directives." };
  const revision = { id: revisionID, ordinal: 1, canonicalContent: JSON.stringify(original),
    contentDigest: "a".repeat(64), approvalId: approvalID, approvedAt: "2026-11-22T10:00:00Z" };
  const document = (ordinal) => ({ id: "10000000-0000-4000-8000-" + String(ordinal).padStart(12, "0"),
    ordinal, title: "Owned manual Ticket", description: "Original request",
    requirementRevisionId: revisionID,
    canonicalContent: JSON.stringify(ordinal === 4 ? fresh : original),
    contentDigest: "b".repeat(64), createdAt: ordinal === 4 ? "2026-11-22T11:00:00Z" : "2026-11-22T09:00:00Z" });
  const noop = () => {};
  const commission = () => setWork(v => v + 1);
  return <main class="factory-desktop" data-background="river-landscape">
    <header class="factory-topbar">
      <button onClick={() => setOpen(true)}>Open Ticket</button>
      <button onClick={() => setOpen(false)}>Close Ticket</button>
      <button onClick={() => setVersion(4)}>Receive authenticated v4</button>
    </header>
    <Show when={open()}>
      <section class="workspace-window">
        <TicketWorkspace
          current={{ ticket: { id: ticketID, title: "Owned manual Ticket",
            description: "Original request", state: "in-progress", version: version() },
            revisions: [revision], documentRevisions: version() === 4 ? [document(4), document(3)] : [document(3)],
            origin: null, followUps: [] }}
          latestRevision={revision} latestRequirement={version() === 4 ? fresh : original}
          change={{ id: "owned-change", requirementApprovalId: approvalID, state: "starting",
            baseSha: "a".repeat(40), branchName: "factory/owned", implementationState: "starting" }}
          storageKey={"ticket-edit:owned-user:" + ticketID} drafts={drafts}
          ticketReference="Owned Ticket" pending={false} epics={[]}
          dependencies={{ prerequisites: [], candidates: [], admitted: true, pending: false,
            onOpen: noop, onAdd: noop, onRemove: noop }}
          clarificationAction={{ label: "", status: false }}
          codingOptionsOpen={false} implementationAvailable canDevelop={false}
          onSaveDocument={async (input) => { setWrites(v => [...v, input]); return undefined; }}
          onConfirmRequirements={commission} onImplement={commission} onCodingOptions={commission}
          onInterview={commission} onAssignEpic={noop} onFollowUp={noop} onOpenTicket={noop}
          onOpenEpic={noop} onTrash={noop} onRestore={noop} onStopImplementation={noop}
          onOpenIDE={noop} onApproveDelivery={noop}
        />
      </section>
    </Show>
    <output class="sr-only" aria-label="Hydration writes">{JSON.stringify(writes())}</output>
    <output class="sr-only" aria-label="Commissioned work">{work()}</output>
  </main>;
}
render(() => <Surface />, document.getElementById("root"));
`;
  test.beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: resolve("test/fixtures"),
      cacheDir: cache,
      publicDir: resolve("apps/factory/public"),
      optimizeDeps: { entries: [] },
      plugins: [
        {
          name: "owned-ticket-hydration-fixture",
          resolveId: (id) => (id === "/ticket-hydration.tsx" ? moduleID : undefined),
          load: (id) => (id === moduleID ? source : undefined),
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (request.url !== "/ticket-hydration.html") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await server.transformIndexHtml(
                  "/ticket-hydration.html",
                  '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/ticket-hydration.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
        factoryFixtureStart(),
        solid({ ssr: false }),
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    origin = fixtureValue(
      fixtureValue(server.resolvedUrls, "hydration server URLs").local[0],
      "hydration local URL",
    ).replace(/\/$/, "");
  });
  test.afterAll(async () => {
    await server?.close();
    await rm(cache, { recursive: true, force: true });
  });
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  test("an unchanged editor survives outer reload and stale-to-fresh hydration without autosaving", async ({
    page,
  }) => {
    await page.goto(`${origin}/ticket-hydration.html`);
    await page.getByRole("button", { name: "Open Ticket", exact: true }).click();
    const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
    await expect(summary).toContainText("Do not implement this fixture");
    await summary.focus();
    await page.getByRole("button", { name: "Close Ticket", exact: true }).click();
    // An already-open installation can have retained this unchanged snapshot before
    // the fix. Hydration must handle it too, not merely stop retaining on focus.
    await page.evaluate(() =>
      localStorage.setItem(
        "ticket-edit:owned-user:10000000-0000-4000-8000-000000000002",
        JSON.stringify({
          title: "Owned manual Ticket",
          description: "Original request",
          expectedVersion: 3,
          expectedDocumentId: "10000000-0000-4000-8000-000000000003",
          requirementRevisionId: "10000000-0000-4000-8000-000000000003",
          requirement: {
            summary: "Old manual specification. Do not implement this fixture.",
            acceptanceCriteria: ["Keep the existing approved scope."],
            nonGoals: [],
          },
        }),
      ),
    );
    await page.reload();
    await page.getByRole("button", { name: "Open Ticket", exact: true }).click();
    await expect(summary).toContainText("Do not implement this fixture");
    await page.getByRole("button", { name: "Receive authenticated v4", exact: true }).click();
    // Cross the autosave interval after the server revision and remounted rich editor settle.
    await page.waitForTimeout(800);
    const evidence = ".factory/test-results/ticket-hydration";
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/hydration-observed.png` });
    await expect(page.getByLabel("Hydration writes", { exact: true })).toHaveText("[]");
    await expect(summary).toHaveText("Fresh manual specification without fixture directives.");
    await expect(page.getByLabel("Commissioned work", { exact: true })).toHaveText("0");
    await expect(page.getByRole("button", { name: "Discard my changes", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText("Not saved.", { exact: false })).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await summary.scrollIntoViewIfNeeded();
      await expect(summary).toHaveText("Fresh manual specification without fixture directives.");
      await page.screenshot({ path: `${evidence}/fresh-read-${width}.png` });
    }
    await page.getByRole("button", { name: "Close Ticket", exact: true }).click();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("ticket-edit:owned-user:10000000-0000-4000-8000-000000000002"),
      ),
    ).toBeNull();
  });
  for (const edited of [false, true])
    test(`a ${edited ? "genuinely edited" : "unchanged"} retained snapshot handles a fresh revision already present on reopen`, async ({
      page,
    }) => {
      await page.goto(`${origin}/ticket-hydration.html`);
      await page.evaluate(
        (edited) =>
          localStorage.setItem(
            "ticket-edit:owned-user:10000000-0000-4000-8000-000000000002",
            JSON.stringify({
              title: "Owned manual Ticket",
              description: "Original request",
              expectedVersion: 3,
              expectedDocumentId: "10000000-0000-4000-8000-000000000003",
              requirementRevisionId: "10000000-0000-4000-8000-000000000003",
              requirement: {
                summary: edited
                  ? "My genuinely unsaved specification."
                  : "Old manual specification. Do not implement this fixture.",
                acceptanceCriteria: ["Keep the existing approved scope."],
                nonGoals: [],
              },
            }),
          ),
        edited,
      );
      await page.getByRole("button", { name: "Receive authenticated v4", exact: true }).click();
      await page.getByRole("button", { name: "Open Ticket", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "Specification summary", exact: true }),
      ).toHaveText(
        edited
          ? "My genuinely unsaved specification."
          : "Fresh manual specification without fixture directives.",
      );
      await page.waitForTimeout(800);
      const writes = JSON.parse(
        (await page.getByLabel("Hydration writes", { exact: true }).textContent()) ?? "[]",
      );
      expect(writes).toHaveLength(edited ? 1 : 0);
      if (edited)
        expect(writes[0]).toMatchObject({
          expectedVersion: 3,
          expectedDocumentId: "10000000-0000-4000-8000-000000000003",
          requirement: { summary: "My genuinely unsaved specification." },
        });
      await expect(page.getByLabel("Commissioned work", { exact: true })).toHaveText("0");
      await expect(
        page.getByRole("button", { name: "Discard my changes", exact: true }),
      ).toHaveCount(edited ? 1 : 0);
      await page.screenshot({
        path: `.factory/test-results/ticket-hydration/fresh-reopen-${edited ? "edited" : "unchanged"}.png`,
      });
    });
  test("fresh hydration keeps genuinely unsaved specification text and conflict recovery", async ({
    page,
  }) => {
    await page.goto(`${origin}/ticket-hydration.html`);
    await page.getByRole("button", { name: "Open Ticket", exact: true }).click();
    const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
    await summary.fill("My genuinely unsaved specification.");
    await page.getByRole("button", { name: "Receive authenticated v4", exact: true }).click();
    await expect(summary).toHaveText("My genuinely unsaved specification.");
    await expect(
      page.getByRole("button", { name: "Discard my changes", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save my version as a new revision", exact: true }),
    ).toBeVisible();
    const writes = JSON.parse(
      (await page.getByLabel("Hydration writes", { exact: true }).textContent()) ?? "[]",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      expectedVersion: 3,
      expectedDocumentId: "10000000-0000-4000-8000-000000000003",
      requirementRevisionId: "10000000-0000-4000-8000-000000000003",
      requirement: { summary: "My genuinely unsaved specification." },
    });
    await expect(page.getByLabel("Commissioned work", { exact: true })).toHaveText("0");
  });
});

test("a newer background read cannot discard the exact autosave acknowledgement", async ({
  page,
}) => {
  const database = createDatabase(2);
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const slug = `autosave-ack-${projectID.slice(0, 8)}`;
  const releaseAck = Promise.withResolvers<void>();
  const releasePoll = Promise.withResolvers<void>();
  const capturedAck = Promise.withResolvers<void>();
  const capturedPoll = Promise.withResolvers<void>();
  const secondWrite = Promise.withResolvers<void>();
  const writes: Array<{
    commandId: string;
    expectedVersion: number;
    expectedDocumentId: string | null;
    requirementRevisionId: string | null;
  }> = [];
  let saved = false;
  let reads = 0;
  let projectCreated = false;
  try {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await browserBootstrap(page);
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${projectID},${slug},'Autosave acknowledgement','https://example.invalid/autosave.git','main','.factory/actor-template.json',${session.user.id})`;
    projectCreated = true;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES(${ticketID},${projectID},'Retain my requirements','A settled checklist.','ready',${session.user.id})`;
    await mockFactoryFunctions(page, {
      workspaces: {
        ensurePersonalSource: async () => {
          throw new CommandError("unavailable", "This document fixture starts no runtime");
        },
        ensureEditor: async () => {
          throw new CommandError("unavailable", "This document fixture starts no runtime");
        },
      },
    });
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.locator(".ticket-card-body").filter({ hasText: "Retain my requirements" }).click();
    const criterion = page.getByRole("textbox", { name: "Acceptance criterion 1", exact: true });
    await expect(criterion).toBeVisible();
    await mockFactoryFunctions(page, {
      tickets: {
        async save(_actor, id, input) {
          writes.push(input);
          const value = await serverCall(browserFunction(page, "saveTicketDocument", [id, input]));
          saved = true;
          if (writes.length >= 2) secondWrite.resolve();
          return value;
        },
        async detail(_actor, id) {
          // The write refresh starts before the newer background read, but their
          // real responses can arrive out of order. Own gates by request order.
          const number = saved && reads < 2 ? ++reads : 0;
          const value = await serverCall(browserFunction(page, "getTicketDetail", [id]));
          if (!number) return value;
          if (number === 1) {
            capturedAck.resolve();
            await releaseAck.promise;
          } else {
            capturedPoll.resolve();
            releaseAck.resolve();
            await releasePoll.promise;
          }
          return value;
        },
      },
    });
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await criterion.fill("The checklist shows the exact checked count.");
    await capturedAck.promise;
    await capturedPoll.promise;
    await criterion.fill("The checklist shows the exact checked count and Reset clears it.");
    await expect.poll(() => writes.length).toBe(2);
    await secondWrite.promise;
    expect(writes[1]).toMatchObject({
      expectedVersion: fixtureValue(writes[0], "writes[0]").expectedVersion + 1,
      expectedDocumentId: fixtureValue(writes[0], "writes[0]").commandId,
      requirementRevisionId: fixtureValue(writes[0], "writes[0]").commandId,
    });
    releasePoll.resolve();
    await expect
      .poll(async () => {
        const [row] = await database.client<{ canonical: string }[]>`
          SELECT canonical_content AS canonical FROM factory.requirement_revision
          WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
        return row?.canonical;
      })
      .toContain("Reset clears it");
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
    await expect(page.getByText("The document changed elsewhere.", { exact: false })).toHaveCount(
      0,
    );
    await mkdir(".factory/test-results/ticket-autosave-ack", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/ticket-autosave-ack/retained-criteria.png",
    });
  } finally {
    releaseAck.resolve();
    releasePoll.resolve();
    try {
      if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    } finally {
      try {
        if (projectCreated) await deleteFactoryProject(projectID, database);
      } finally {
        await database.client.end();
      }
    }
  }
});

for (const switchProject of [false, true])
  test(`held autosave ACK keeps newer A text out of selected B across ${switchProject ? "Projects" : "Tickets"}`, async ({
    page,
  }) => {
    const database = createDatabase(2);
    const projectA = crypto.randomUUID();
    const projectB = switchProject ? crypto.randomUUID() : projectA;
    const ticketA = crypto.randomUUID();
    const ticketB = crypto.randomUUID();
    const projects: string[] = [];
    const release = Promise.withResolvers<void>();
    const writes: Array<{ ticketID: string; description: string; expectedVersion: number }> = [];
    let acknowledgedVersion: number | undefined;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page);
      const { session } = await browserBootstrap(page);
      for (const id of new Set([projectA, projectB])) {
        await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
          VALUES(${id},${`owned-save-${id}`},'Owned autosave','https://example.invalid/autosave.git','main','.factory/actor-template.json',${session.user.id})`;
        projects.push(id);
      }
      await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
        VALUES(${ticketA},${projectA},'Owned Ticket A','Original A','ready',${session.user.id}),
          (${ticketB},${projectB},'Selected Ticket B','Original B','ready',${session.user.id})`;
      await mockFactoryFunctions(page, {
        workspaces: {
          ensurePersonalSource: async () => {
            throw new CommandError("unavailable", "Owned autosave fixture starts no runtime");
          },
          ensureEditor: async () => {
            throw new CommandError("unavailable", "Owned autosave fixture starts no runtime");
          },
        },
        tickets: {
          async save(_actor, id, input) {
            writes.push({ ticketID: id, ...input });
            const value = await serverCall(
              browserFunction(page, "saveTicketDocument", [id, input]),
            );
            if (writes.length === 1) {
              acknowledgedVersion = value.ticketVersion;
              await release.promise;
            }
            return value;
          },
        },
      });
      await openProjectMenu(page);
      await page
        .getByRole("button")
        .filter({ hasText: `owned-save-${projectA}` })
        .click();
      if (!switchProject) {
        await page.locator(".ticket-card-body").filter({ hasText: "Selected Ticket B" }).click();
        await expect(
          page.getByRole("textbox", { name: "Ticket description", exact: true }),
        ).toHaveText("Original B");
        await page
          .getByRole("navigation", { name: "Workspace dock", exact: true })
          .getByRole("button", { name: "Desktop", exact: true })
          .click();
      }
      await page.locator(".ticket-card-body").filter({ hasText: "Owned Ticket A" }).click();
      const description = page.getByRole("textbox", { name: "Ticket description", exact: true });
      await expect(description).toHaveText("Original A");
      await page.clock.install();
      await description.fill("Admitted A text");
      await page.clock.runFor(700);
      await expect.poll(() => acknowledgedVersion).toBeDefined();
      await description.fill("Newer A text retained while its ACK is held");
      if (switchProject) {
        await openProjectMenu(page);
        await page
          .getByRole("button")
          .filter({ hasText: `owned-save-${projectB}` })
          .click();
        await page.locator(".ticket-card-body").filter({ hasText: "Selected Ticket B" }).click();
      } else {
        await page
          .getByRole("tablist", { name: "Open workspace views" })
          .getByRole("tab", { name: "Selected Ticket B", exact: true })
          .click();
      }
      await expect(description).toHaveText("Original B");
      release.resolve();
      const storageKey = `ticket-edit:${session.user.id}:${ticketA}`;
      await expect
        .poll(() =>
          page.evaluate((key) => {
            const draft = JSON.parse(localStorage.getItem(key) ?? "null");
            return draft?.expectedVersion;
          }, storageKey),
        )
        .toBe(fixtureValue(acknowledgedVersion, "held autosave version"));
      // Run past the debounce after the ACK has settled. The disposed A editor must stay quiet.
      await page.clock.runFor(1000);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.ticketID).toBe(ticketA);
      await expect(page).toHaveURL(new RegExp(`/projects/${projectB}/tickets/${ticketB}$`));
      await expect(description).toHaveText("Original B");
      const [other] = await database.client<{ description: string; version: string }[]>`
        SELECT description,version FROM factory.ticket WHERE id=${ticketB}`;
      expect(other).toMatchObject({ description: "Original B", version: "1" });
      await mkdir(".factory/test-results/ticket-autosave-ack", { recursive: true });
      const capture = `.factory/test-results/ticket-autosave-ack/held-${switchProject ? "project" : "ticket"}`;
      await page.screenshot({ path: `${capture}-b-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(description).toHaveText("Original B");
      await page.screenshot({ path: `${capture}-b-narrow.png` });
      await page.setViewportSize({ width: 1440, height: 900 });
      if (switchProject) {
        await openProjectMenu(page);
        await page
          .getByRole("button")
          .filter({ hasText: `owned-save-${projectA}` })
          .click();
      } else {
        await page
          .getByRole("navigation", { name: "Workspace dock", exact: true })
          .getByRole("button", { name: "Desktop", exact: true })
          .click();
      }
      await page.locator(".ticket-card-body").filter({ hasText: "Owned Ticket A" }).click();
      await expect(description).toHaveText("Newer A text retained while its ACK is held");
      await page.clock.runFor(700);
      await expect.poll(() => writes.length).toBe(2);
      expect(writes[1]).toMatchObject({
        ticketID: ticketA,
        description: "Newer A text retained while its ACK is held",
        expectedVersion: acknowledgedVersion,
      });
      await expect
        .poll(
          async () =>
            (
              await database.client<{ description: string }[]>`
          SELECT description FROM factory.ticket WHERE id=${ticketA}`
            )[0]?.description,
        )
        .toBe("Newer A text retained while its ACK is held");
      await page.screenshot({ path: `${capture}-returned-a.png` });
    } finally {
      release.resolve();
      try {
        if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
      } finally {
        try {
          for (const id of projects) await deleteFactoryProject(id, database);
        } finally {
          await database.client.end();
        }
      }
    }
  });
