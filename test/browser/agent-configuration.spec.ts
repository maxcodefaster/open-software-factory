import { requestFunction } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import { mkdir } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { z } from "zod";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn } from "../support/factory-fixture";
import {
  browserBootstrap,
  browserFunction,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(90_000);

test("admitted configuration is readable, private to Project members, and distinct from next defaults", async ({
  page,
  browser,
}) => {
  const database = createDatabase(1);
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const conversationID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const short = projectID.slice(0, 8);
  const title = `Configuration QA ${short}`;
  const password = "owned-configuration-browser-password";
  const users: Array<{ id: string; email: string }> = [];
  const developerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  const developer = await developerContext.newPage();
  const outsider = await outsiderContext.newPage();
  const errors: string[] = [];
  for (const current of [page, developer, outsider])
    current.on("pageerror", (error) => errors.push(error.message));
  for (const current of [page, developer, outsider]) {
    await mockFactoryFunctions(current, {
      workspaces: {
        ensurePersonalSource: async () => {
          throw new CommandError(
            "unavailable",
            "Controlled planning fixture has no source repository",
          );
        },
      },
    });
    await mockFactoryFunctions(current, {
      workspaces: {
        ensureEditor: async () => {
          throw new CommandError("unavailable", "Controlled planning fixture has no IDE");
        },
      },
    });
  }
  async function login(current: Page, email: string) {
    await current.goto("/");
    await current.getByLabel("Email", { exact: true }).fill(email);
    await current.getByLabel("Password", { exact: true }).fill(password);
    await current.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(current.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  }
  async function openAgent(current: Page) {
    await openProjectMenu(current);
    await current
      .getByRole("button")
      .filter({ hasText: `config-qa-${short}` })
      .click();
    await current
      .getByRole("region", { name: "ideas", exact: true })
      .locator(".ticket-card-body")
      .click();
    await current.getByRole("button", { name: "Toggle Agent panel" }).click();
    const panel = current.getByRole("complementary", { name: "Agent panel" });
    await expect(panel.locator(".agent-turn-details")).toHaveCount(0);
    return panel;
  }
  try {
    await mkdir(".factory/test-results/agent-configuration", { recursive: true });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const administrator = z
      .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
      .parse(await browserBootstrap(page)).session.user.id;
    for (const role of ["developer", "outsider"] as const) {
      const response = await browserFunction(page, "createAccount", [
        {
          name: `Configuration QA ${role}`,
          email: `${role}-${projectID}@factory.local`,
          password,
        },
      ]);
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error(response.message);
      users.push(z.object({ id: z.uuid(), email: z.email() }).parse(response.value));
    }
    const member = users[0];
    const nonMember = users[1];
    if (!member || !nonMember) throw new Error("Owned accounts missing");
    await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`config-qa-${short}`}, ${title}, 'https://example.invalid/configuration.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
    await database.client`INSERT INTO factory.project_membership(project_id, user_id, role, updated_by)
      VALUES (${projectID}, ${member.id}, 'developer', ${administrator})`;
    await database.client`INSERT INTO factory.ticket(id, project_id, title, created_by)
      VALUES (${ticketID}, ${projectID}, 'Inspect the retained configuration', ${member.id})`;
    await database.client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
      VALUES (${conversationID}, ${projectID}, ${ticketID}, 'plan', ${member.id})`;
    const skills = createSkillController(database);
    await skills.publish(
      {
        revisionId: revisionID,
        expectedRevision: 0,
        content: {
          ...requirementsInterviewSkill,
          key: `config-qa-${short}`,
          name: "Requirements interview",
        },
      },
      administrator,
    );
    const turns = createAgentTurnStore(database);
    const admitted = await turns.admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId: projectID,
        ticketId: ticketID,
        conversationId: conversationID,
        createdBy: member.id,
        text: "Controlled browser presentation fixture, no paid model work.",
      },
      {
        mode: "plan",
        conversationVersion: 1,
        modelId: "admitted-model-not-current-default",
        skillRevisionIds: [revisionID],
      },
    );
    const owner = await turns.claimPending(admitted.turn.id);
    if (!owner?.ownerToken) throw new Error("Owned Turn lease missing");
    await turns.beginDispatch(owner.id, owner.ownerToken);
    await database.client`INSERT INTO factory.agent_turn_skill(turn_id, revision_id) VALUES (${owner.id}, ${revisionID})`;
    await turns.settle(
      owner.id,
      owner.ownerToken,
      "completed",
      "Controlled response saved; no Delivery was performed.",
    );
    await login(developer, member.email);
    await login(outsider, nonMember.email);
    expect(
      await requestFunction(outsider.request, "getConversation", [
        projectID,
        { ticketId: ticketID },
      ]),
    ).toMatchObject({ ok: false, status: 404 });
    expect(await browserFunction(outsider, "getProjectModels", [projectID])).toMatchObject({
      ok: false,
      status: 404,
    });
    const observed = await serverCall(
      requestFunction(developer.request, "getConversation", [projectID, { ticketId: ticketID }]),
    );
    if (!observed) throw new Error("Owned configuration conversation is missing");
    expect(observed.turn).toMatchObject({
      id: owner.id,
      engine: "mastra",
      mode: "plan",
      modelId: "admitted-model-not-current-default",
      skills: [{ id: revisionID, name: "Requirements interview", revision: 1, loaded: true }],
    });
    const panel = await openAgent(developer);
    const composer = panel.getByLabel("Message conversation");
    await composer.fill("Retain this draft while inspecting configuration.");
    await developer.getByRole("button", { name: "Minimize Agent panel", exact: true }).click();
    const skillDefaults = await serverCall(
      browserFunction(developer, "getInheritedSkills", [projectID]),
    );
    let skillUnavailable = true;
    await mockFactoryFunctions(developer, {
      skills: {
        async inherited() {
          if (!skillUnavailable)
            return serverCall(browserFunction(developer, "getInheritedSkills", [projectID]));
          return {
            ...skillDefaults,
            effective: {
              ...skillDefaults.effective,
              planning: { ...skillDefaults.effective.planning, available: false },
            },
          };
        },
      },
    });
    await developer.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText(
      "Ask a manager to restore publication or change the assignment",
    );
    await expect(composer).toHaveValue("Retain this draft while inspecting configuration.");
    await panel.getByRole("button", { name: "Open settings", exact: true }).click();
    const settings = developer.getByRole("region", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await expect(developer.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(
      developer.getByRole("dialog", { name: "Agent settings", exact: true }),
    ).toHaveCount(0);
    await settings
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await developer.screenshot({
      path: ".factory/test-results/agent-configuration/developer-settings.png",
    });
    skillUnavailable = false;
    const retainedTab = developer.getByRole("tab", {
      name: "Inspect the retained configuration",
      exact: true,
    });
    await retainedTab.click();
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(composer).toHaveValue("Retain this draft while inspecting configuration.");
    const retained = await serverCall(
      requestFunction(developer.request, "getConversation", [projectID, { ticketId: ticketID }]),
    );
    if (!retained) throw new Error("Retained configuration conversation is missing");
    expect(retained.turn).toEqual(observed.turn);
    await developer.screenshot({ path: ".factory/test-results/agent-configuration/wide.png" });
    await developer.setViewportSize({ width: 430, height: 860 });
    const narrow = developer.getByRole("dialog", { name: "Agent panel", exact: true });
    await expect(narrow).toBeVisible();
    expect(await narrow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await developer.screenshot({ path: ".factory/test-results/agent-configuration/narrow.png" });
    await developer.keyboard.press("Escape");
    await expect(narrow).toBeHidden();
    await expect(retainedTab).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await developer.unrouteAll({ behavior: "ignoreErrors" });
    await developerContext.close();
    await outsiderContext.close();
    try {
      await database.client.begin(async (sql) => {
        const [safe] = await sql<
          Array<{ id: string }>
        >`SELECT id FROM factory.project WHERE id = ${projectID}
          AND slug = ${`config-qa-${short}`} AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id = ${projectID})`;
        if (safe) {
          await sql`DELETE FROM factory.forge_grant_intent WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.agent_turn WHERE project_id = ${projectID}`;
          await sql`DELETE FROM factory.ticket_conversation WHERE project_id = ${projectID}`;
          await sql`DELETE FROM factory.ticket WHERE project_id = ${projectID}`;
          await sql`DELETE FROM factory.project WHERE id = ${projectID}`;
        } else if ((await sql`SELECT id FROM factory.project WHERE id = ${projectID}`).length) {
          throw new Error("Owned configuration fixture acquired a runtime; cleanup refused");
        }
        await sql`SET LOCAL session_replication_role = replica`;
        await sql`DELETE FROM factory.skill_publication WHERE revision_id = ${revisionID}`;
        await sql`DELETE FROM factory.skill_revision WHERE id = ${revisionID} AND skill_key = ${`config-qa-${short}`}`;
        // Restore constraints and cascades before deleting owned identities.
        await sql`SET LOCAL session_replication_role = origin`;
        for (const user of users) {
          await sql`DELETE FROM factory.forge_grant_intent WHERE user_id=${user.id}`;
          await sql`DELETE FROM auth.account WHERE user_id=${user.id}`;
          await sql`DELETE FROM factory.forge_account_intent WHERE user_id=${user.id}`;
          await sql`DELETE FROM factory.developer_ide WHERE user_id=${user.id} AND state='stopped'`;
          await sql`DELETE FROM auth."user" WHERE id = ${user.id} AND email = ${user.email}`;
        }
      });
      for (const user of users) {
        expect(
          await database.client`SELECT user_id FROM factory.account_access WHERE user_id=${user.id}`,
        ).toHaveLength(0);
        expect(
          await database.client`SELECT user_id FROM auth.session WHERE user_id=${user.id}`,
        ).toHaveLength(0);
      }
    } finally {
      await database.client.end();
    }
  }
});
