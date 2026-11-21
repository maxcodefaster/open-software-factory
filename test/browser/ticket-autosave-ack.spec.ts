import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { CommandError } from "../../apps/factory/src/command-error";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  browserBootstrap,
  browserFunction,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

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
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Autosave acknowledgement','https://example.invalid/autosave.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
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
        await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
          VALUES(${id},${`owned-save-${id}`},'Owned autosave','https://example.invalid/autosave.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
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
