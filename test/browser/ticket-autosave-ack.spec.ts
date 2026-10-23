import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
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
    const { session } = await (await page.request.get("/api/session")).json();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Autosave acknowledgement','https://example.invalid/autosave.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    projectCreated = true;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES(${ticketID},${projectID},'Retain my requirements','A settled checklist.','ready',${session.user.id})`;
    for (const action of ["source-workspace", "developer-ide"])
      await page.route(`**/api/projects/${projectID}/${action}/ensure`, (route) =>
        route.fulfill({ status: 503, json: { error: "This document fixture starts no runtime" } }),
      );
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.locator(".ticket-card-body").filter({ hasText: "Retain my requirements" }).click();
    const criterion = page.getByRole("textbox", { name: "Acceptance criterion 1", exact: true });
    await expect(criterion).toBeVisible();
    await page.route(`**/api/tickets/${ticketID}/document`, async (route) => {
      writes.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (response.ok()) saved = true;
      await route.fulfill({ response });
      if (writes.length >= 2) secondWrite.resolve();
    });
    await page.route(`**/api/tickets/${ticketID}`, async (route) => {
      if (!saved || reads >= 2) return route.continue();
      const number = ++reads;
      const response = await route.fetch();
      if (number === 1) {
        capturedAck.resolve();
        await releaseAck.promise;
      } else {
        capturedPoll.resolve();
        releaseAck.resolve();
        await releasePoll.promise;
      }
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await criterion.fill("The checklist shows the exact checked count.");
    await capturedAck.promise;
    await capturedPoll.promise;
    await criterion.fill("The checklist shows the exact checked count and Reset clears it.");
    await expect.poll(() => writes.length).toBe(2);
    await secondWrite.promise;
    expect(writes[1]).toMatchObject({
      expectedVersion: writes[0]!.expectedVersion + 1,
      expectedDocumentId: writes[0]!.commandId,
      requirementRevisionId: writes[0]!.commandId,
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
