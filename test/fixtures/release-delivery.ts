import { expect } from "bun:test";
import { resolve } from "node:path";
import { expect as visible } from "@playwright/test";
import { deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import { z } from "zod";
import type { releaseInstallation } from "./release-installation";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

export async function releaseDelivery(fixture: Fixture) {
  const { state, database } = fixture;
  const { projectID, ticketID, changeID, verifiedSHA } = state;
  if (
    !projectID ||
    !ticketID ||
    !changeID ||
    !verifiedSHA ||
    !state.completed.includes("workspace")
  )
    throw new Error("Exact verified Build and real Workspace proof required before Delivery");
  const cookie = await fixture.login("developer");
  const [change] = await database.client<
    Array<{ state: string }>
  >`SELECT state FROM factory.change WHERE id = ${changeID}`;
  const alreadyDelivered = change?.state === "delivered";
  const page = await fixture.page("developer");
  await fixture.selectProject(page);
  if (alreadyDelivered) await page.getByRole("button", { name: /^Completed/ }).click();
  await page
    .locator(alreadyDelivered ? ".ticket-archive button" : ".ticket-card-body")
    .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` })
    .click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const stagingOption = page.getByRole("menuitem", { name: /Staging/ });
  if (await stagingOption.isVisible()) await stagingOption.click();
  const preview = page.locator('iframe[title="Factory Preview"]').contentFrame();
  await visible(preview.locator("h1")).toBeVisible({ timeout: 30_000 });
  expect(await preview.locator("body").evaluate(async () => (await fetch("./health")).status)).toBe(
    200,
  );
  const initial = await database.client<Array<{ id: string; revision: string; state: string }>>`
    SELECT attempt.id, preview.revision, attempt.state FROM factory.staging_preview preview
    JOIN factory.runtime_attempt attempt ON attempt.id = preview.runtime_attempt_id WHERE preview.project_id = ${projectID}`;
  expect(initial[0]?.state).toBe("ready");
  if (!alreadyDelivered) expect(initial[0]?.revision).not.toBe(verifiedSHA);
  await page.getByRole("tab", { name: /Create centered welcome/ }).click();
  const delivery = deliveryViewSchema.parse(
    await fixture.command(cookie, `/api/changes/${changeID}/delivery`),
  );
  expect(delivery.verificationState).toBe("succeeded");
  expect(delivery.verificationCommitSha).toBe(verifiedSHA);
  if (!state.dependentTicketID) throw new Error("Dependent release Ticket required");
  if (!state.completed.includes("dependent-blocked")) {
    if (alreadyDelivered) throw new Error("Pre-delivery blocked admission was not proven");
    const [existing] = await database.client<Array<{ id: string }>>`
    SELECT id FROM factory.requirement_revision WHERE ticket_id = ${state.dependentTicketID}
    ORDER BY ordinal DESC LIMIT 1`;
    const revision =
      existing ??
      z.object({ id: z.uuid() }).parse(
        await fixture.command(
          cookie,
          `/api/tickets/${state.dependentTicketID}/requirements`,
          "POST",
          {
            summary: `Set src/version.txt to exactly ${fixture.slug}-follow-on followed by a newline. Run node --check src/server.mjs. Preserve the welcome dashboard.`,
            acceptanceCriteria: [
              `src/version.txt contains exactly ${fixture.slug}-follow-on followed by a newline`,
              "node --check src/server.mjs passes",
            ],
            nonGoals: ["Dependencies, runtime configuration and other file changes"],
          },
        ),
      );
    await fixture.command(
      cookie,
      `/api/tickets/${state.dependentTicketID}/requirements/${revision.id}/approve`,
      "POST",
      {},
    );
    const blocked = await fixture.request(
      cookie,
      `/api/tickets/${state.dependentTicketID}/change`,
      "POST",
      {},
    );
    expect(blocked.status).toBe(409);
    expect(z.object({ error: z.string() }).parse(blocked.body).error).toContain(
      "Prerequisites must be delivered",
    );
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id = ${state.dependentTicketID}`,
    ).toHaveLength(0);
    await fixture.save("dependent-blocked", 0);
  }
  const started = performance.now();
  if (!alreadyDelivered) {
    await visible(
      page.getByRole("button", { name: "Approve delivery", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Approve delivery", exact: true }).click();
  }
  let promoted: { id: string; revision: string; state: string; changeState: string } | undefined;
  await visible
    .poll(
      async () => {
        const [current] = await database.client<
          Array<{ id: string; revision: string; state: string; changeState: string }>
        >`
      SELECT attempt.id, preview.revision, attempt.state, change.state AS "changeState" FROM factory.staging_preview preview
      JOIN factory.runtime_attempt attempt ON attempt.id = preview.runtime_attempt_id
      JOIN factory.change change ON change.project_id = preview.project_id
      WHERE preview.project_id = ${projectID} AND change.id = ${changeID}`;
        promoted = current;
        return (
          current && {
            revision: current.revision,
            state: current.state,
            changeState: current.changeState,
          }
        );
      },
      { timeout: 360_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toEqual({ revision: verifiedSHA, state: "ready", changeState: "delivered" });
  if (!alreadyDelivered) expect(promoted?.id).not.toBe(initial[0]?.id);
  const [approval] = await database.client<Array<{ email: string; sha: string }>>`
    SELECT human.email, approval.commit_sha AS sha FROM factory.delivery_approval approval
    JOIN auth."user" human ON human.id = approval.approved_by WHERE approval.change_id = ${changeID}`;
  expect(approval).toEqual({ email: fixture.credentials("developer").email, sha: verifiedSHA });
  const exact = deliveryViewSchema.parse(
    await fixture.command(cookie, `/api/changes/${changeID}/delivery`),
  );
  expect(exact.mergedCommitSha).toBe(verifiedSHA);
  await page.getByRole("tab", { name: "Preview · Staging", exact: true }).click();
  await visible(preview.locator("h1")).toContainText(/welcome/i, { timeout: 60_000 });
  const source: unknown = await preview
    .locator("body")
    .evaluate(async () => (await fetch("./source")).json());
  fixture.noSecrets(JSON.stringify(source));
  expect(source).toMatchObject({ version: fixture.slug });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: resolve(fixture.evidence, "delivered-staging-wide.png") });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: resolve(fixture.evidence, "delivered-staging-narrow.png") });
  state.deliveredSHA = verifiedSHA;
  await fixture.save("delivery", performance.now() - started);
}
