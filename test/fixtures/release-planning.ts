import { expect } from "bun:test";
import { resolve } from "node:path";
import { expect as visible, type Page, type Response } from "@playwright/test";
import {
  conversationViewSchema,
  type ConversationView,
  ticketDetailSchema,
} from "../../apps/factory/src/api-contracts";
import { markdownHTML } from "../../apps/factory/src/markdown";
import { interviewQuestionInput } from "../../packages/conversation-domain/src/conversation";
import { requirementContentInput } from "../../packages/requirement-domain/src/content";
import type { releaseInstallation } from "./release-installation";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

export async function releasePlanning(fixture: Fixture) {
  const { state, database } = fixture;
  const { projectID, ticketID } = state;
  if (!projectID || !ticketID || !state.completed.includes("setup"))
    throw new Error("Release setup must complete before planning");
  const cookie = await fixture.login("developer");
  const page = await fixture.page("developer");
  await fixture.selectProject(page);
  await page
    .getByRole("region", { name: "Ticket board" })
    .locator(".ticket-card-body")
    .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const conversationPath = `/api/projects/${projectID}/conversation`;
  async function conversation() {
    return conversationViewSchema
      .nullable()
      .parse(await fixture.command(cookie, `${conversationPath}?ticketId=${ticketID}`));
  }
  async function result(response: Response) {
    const body: unknown = await response.json();
    fixture.noSecrets(JSON.stringify(body));
    if (!response.ok())
      throw new Error(`Release planning UI command returned ${response.status()}`);
    return conversationViewSchema.parse(body);
  }
  async function message(text: string) {
    await page.getByRole("textbox", { name: "Message conversation", exact: true }).fill(text);
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === `${conversationPath}/message` &&
        value.request().method() === "POST",
      { timeout: 120_000 },
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    return result(await response);
  }
  async function screenshot(name: string) {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(fixture.evidence, `${name}.png`) });
  }
  if (!state.completed.includes("investigate")) {
    const started = performance.now();
    const previous = await conversation();
    const cited = previous?.entries.find(
      (entry) =>
        entry.kind === "agent-message" &&
        entry.citations.some((citation) => citation.source === "knowledge"),
    );
    const output =
      cited && previous
        ? previous
        : await message(
            "Search this Project's generated Knowledge for the System Contract and runtime App. Explain which App we can preview and which health and source endpoints the welcome dashboard must preserve. Cite the actual Knowledge pages you searched. Do not propose a Requirement yet.",
          );
    const answer = output.entries.findLast((entry) => entry.kind === "agent-message");
    expect(answer?.citations.some((citation) => citation.source === "knowledge")).toBe(true);
    await visible(page.locator(".markdown-body .inline-citation").first()).toBeVisible();
    await screenshot("investigate-wide");
    await fixture.save("investigate", performance.now() - started);
  }
  await page
    .getByRole("navigation", { name: "Conversation mode" })
    .getByRole("button", { name: "Plan", exact: true })
    .click();
  await visible(
    page
      .getByRole("navigation", { name: "Conversation mode" })
      .getByRole("button", { name: "Plan", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  function unanswered(view: ConversationView | null, type: "single-select" | "multi-select") {
    if (!view) throw new Error("Release Ticket conversation is missing");
    const entry = view.entries.findLast(
      (entry) =>
        entry.kind === "question" &&
        !view.entries.some((answer) => answer.inReplyToEntryId === entry.id),
    );
    if (!entry) throw new Error(`Real Plan did not ask the needed ${type} question`);
    const question = interviewQuestionInput.parse(entry.payload["question"]);
    expect(question.type).toBe(type);
    return { entry, question };
  }
  async function answer(form: ReturnType<Page["locator"]>) {
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === `${conversationPath}/answer` &&
        value.request().method() === "POST",
      { timeout: 120_000 },
    );
    await form.getByRole("button", { name: "Continue", exact: true }).click();
    return result(await response);
  }
  if (!state.completed.includes("interview-single")) {
    const started = performance.now();
    let view = await conversation();
    if (!view?.entries.some((entry) => entry.kind === "question"))
      view = await message(
        "Plan this Ticket's welcome dashboard, but two product choices are still unknown. First ask one single-select question about the dashboard layout. After I answer, ask one multi-select question about which welcome sections to include, allowing a custom answer. After both answers propose the Requirement. It must keep /health, /source and existing WebSocket/version behavior, use only the existing vanilla Node App, preserve runtime configuration/dependencies, set src/version.txt to exactly " +
          fixture.slug +
          " followed by a newline, and include node --check src/server.mjs. The headings and controls must be readable without overlap. Build must inspect the declared App using Factory's isolated browser DOM, console and screenshot tools before and after editing. Do not implement anything in Plan.",
      );
    const { entry, question } = unanswered(view, "single-select");
    const form = page.locator(".conversation-question").filter({ hasText: entry.body });
    expect(question.type === "single-select" && question.options.length >= 2).toBe(true);
    await form.locator('input[name="option"]').first().check();
    await screenshot("interview-single-wide");
    await answer(form);
    await fixture.save("interview-single", performance.now() - started);
  }
  if (!state.completed.includes("interview-multi")) {
    const started = performance.now();
    const { entry, question } = unanswered(await conversation(), "multi-select");
    expect(question.type === "multi-select" && question.allowCustom).toBe(true);
    const form = page.locator(".conversation-question").filter({ hasText: entry.body });
    await form.locator('input[name="option"]').nth(0).check();
    await form.locator('input[name="option"]').nth(1).check();
    await form.locator('input[name="custom-choice"]').check();
    await form
      .getByRole("textbox", { name: "Custom answer" })
      .fill(
        "Also show an accessible Continue button in normal flow below the dashboard heading and a short delivery-status note. No overlapping controls and no extra dependencies.",
      );
    await screenshot("interview-multi-custom-wide");
    const output = await answer(form);
    expect(output.entries.at(-1)?.kind).toBe("requirement");
    await fixture.save("interview-multi", performance.now() - started);
  }
  if (!state.completed.includes("spec")) {
    const started = performance.now();
    const original = ticketDetailSchema.parse(
      await fixture.command(cookie, `/api/tickets/${ticketID}`),
    );
    const latest = original.revisions[0];
    if (!latest) throw new Error("Real Plan did not produce an immutable Requirement");
    const content = requirementContentInput.parse(JSON.parse(latest.canonicalContent));
    const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
    await visible(summary).toHaveJSProperty("innerHTML", markdownHTML(content.summary));
    await summary.click();
    await summary.press("ControlOrMeta+End");
    await summary.press("/");
    await visible(page.getByRole("menu", { name: "Specification blocks" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Acceptance criterion", exact: true }).click();
    const newCriterion = page.getByRole("textbox", {
      name: `Acceptance criterion ${content.acceptanceCriteria.length + 1}`,
      exact: true,
    });
    await newCriterion.fill(
      "The Continue button is keyboard accessible and never overlaps the dashboard heading at desktop or narrow viewport widths.",
    );
    await summary.fill(
      "Deliver the **developer welcome dashboard** selected in the Requirements Interview. " +
        content.summary,
    );
    await screenshot("spec-edit-wide");
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await visible(page.getByRole("button", { name: "Save revision", exact: true })).toBeHidden();
    const edited = ticketDetailSchema.parse(
      await fixture.command(cookie, `/api/tickets/${ticketID}`),
    );
    expect(edited.revisions).toHaveLength(original.revisions.length + 1);
    for (const revision of original.revisions)
      expect(edited.revisions.find((value) => value.id === revision.id)).toEqual(revision);
    state.editedRevisionID = edited.revisions[0]?.id;
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await visible(summary).toHaveAttribute("aria-readonly", "true");
    const approved = ticketDetailSchema.parse(
      await fixture.command(cookie, `/api/tickets/${ticketID}`),
    );
    expect(approved.revisions[0]?.id).toBe(state.editedRevisionID);
    expect(approved.revisions[0]?.approvalId).toBeDefined();
    const [turn] = await database.client<Array<{ model: string; skills: string[] }>>`
      SELECT authority->>'modelId' AS model, authority->'skillRevisionIds' AS skills FROM factory.agent_turn
      WHERE input->>'ticketId' = ${ticketID} AND authority->>'mode' = 'plan' ORDER BY created_at DESC LIMIT 1`;
    expect(turn?.model).toBe(process.env["FACTORY_AGENT_MODEL_ID"]);
    expect(turn?.skills).toContain(state.planningSkillID);
    await screenshot("spec-approved-wide");
    await page.setViewportSize({ width: 900, height: 900 });
    await page.getByRole("button", { name: "Minimize Agent panel" }).click();
    await screenshot("spec-approved-narrow");
    await fixture.save("spec", performance.now() - started);
  }
}
