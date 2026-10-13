import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { expect as visible } from "@playwright/test";
import { conversationViewSchema, ticketDetailSchema } from "../../apps/factory/src/api-contracts";
import { markdownHTML } from "../../apps/factory/src/markdown";
import { requirementContentInput } from "../../packages/requirement-domain/src/content";
import { releaseInstallation } from "../fixtures/release-installation";

const installation = process.env["FACTORY_RELEASE_INSTALLATION"];
test.skipIf(!installation)(
  "superseded conversation proposals cannot offer approval of an obsolete Spec",
  async () => {
    if (!installation) throw new Error("Explicit disposable installation required");
    const fixture = await releaseInstallation(installation);
    try {
      const { ticketID } = fixture.state;
      if (!ticketID) throw new Error("Release Ticket required");
      const page = await fixture.page("developer");
      await fixture.selectProject(page);
      const card = page
        .locator(".ticket-card-body")
        .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` });
      if (!(await card.isVisible())) await page.getByRole("button", { name: /^Completed/ }).click();
      await page
        .locator(".ticket-card-body, .ticket-archive button")
        .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` })
        .click();
      await page.getByRole("button", { name: "Toggle Agent panel" }).click();
      const panel = page.getByRole("complementary", { name: "Agent panel" });
      await visible(panel.locator(".conversation-requirement")).toBeVisible();
      await visible(panel.getByRole("button", { name: "Approve exact revision" })).toHaveCount(0);
      await visible(
        panel.getByText("Superseded by a newer revision", { exact: true }),
      ).toBeVisible();
    } finally {
      await fixture.close();
    }
  },
  20_000,
);
for (const action of ["message", "answer"] as const) {
  test.skipIf(!installation)(
    `refreshes an already open Ticket after a Plan ${action} proposal`,
    async () => {
      if (!installation) throw new Error("Explicit disposable installation required");
      const fixture = await releaseInstallation(installation);
      try {
        const { projectID, ticketID } = fixture.state;
        if (!projectID || !ticketID) throw new Error("Release Project and Ticket required");
        const cookie = await fixture.login("developer");
        const detail = ticketDetailSchema.parse(
          await fixture.command(cookie, `/api/tickets/${ticketID}`),
        );
        const revision = detail.revisions[0];
        if (!revision) throw new Error("Existing real Plan proposal required");
        const requirement = requirementContentInput.parse(JSON.parse(revision.canonicalContent));
        const path = `/api/projects/${projectID}/conversation`;
        const proposal = conversationViewSchema.parse(
          await fixture.command(cookie, `${path}?ticketId=${ticketID}`),
        );
        const question = proposal.entries.find((entry) => entry.kind === "question");
        if (!question) throw new Error("Existing real interview question required");
        const page = await fixture.page("developer");
        let ticketReads = 0;
        await page.route(`**/api/tickets/${ticketID}`, (route) => {
          ticketReads += 1;
          return route.fulfill({ json: ticketReads === 1 ? { ...detail, revisions: [] } : detail });
        });
        await page.route(`**/api/projects/${projectID}/conversation?*`, (route) =>
          route.fulfill({
            json: { ...proposal, mode: "plan", entries: action === "answer" ? [question] : [] },
          }),
        );
        await page.route(`**/api/projects/${projectID}/conversation/${action}`, (route) =>
          route.fulfill({ json: proposal }),
        );
        await fixture.selectProject(page);
        await page
          .locator(".ticket-card-body")
          .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` })
          .click();
        await visible(
          page.getByRole("textbox", { name: "Specification summary", exact: true }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "Toggle Agent panel" }).click();
        if (action === "answer") {
          const form = page.locator(".conversation-question");
          await form.locator('input[name="option"]').first().check();
          await form.getByRole("button", { name: "Continue", exact: true }).click();
        } else {
          await page
            .getByRole("textbox", { name: "Message conversation", exact: true })
            .fill("Propose the complete Requirement now.");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
        }
        await visible(page.locator(".conversation-requirement")).toBeVisible();
        await visible(
          page.getByRole("textbox", { name: "Specification summary", exact: true }),
        ).toHaveJSProperty("innerHTML", markdownHTML(requirement.summary), { timeout: 5_000 });
        expect(ticketReads).toBeGreaterThan(1);
        await page.screenshot({
          path: resolve(fixture.evidence, `proposal-refresh-${action}.png`),
        });
      } catch (cause) {
        await fixture.capture(`proposal-refresh-${action}-failure`);
        throw cause;
      } finally {
        await fixture.close();
      }
    },
    20_000,
  );
}
