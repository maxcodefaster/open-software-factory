import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { CommandError } from "../../apps/factory/src/command-error";
import { modelSettingsView } from "../../packages/conversation-domain/src/model-settings";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  browserBootstrap,
  mockBootstrap,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test("saving a first managed Coding model enables Implement without reloading the workspace", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const database = createDatabase(2);
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const connectionID = crypto.randomUUID();
  const slug = `model-ready-${projectID.slice(0, 8)}`;
  let configured = false;
  let checks = 0;
  let created = false;
  await mockBootstrap(page, (value) => ({ ...value, modelRelayConfigured: configured }));
  await mockFactoryFunctions(page, {
    models: {
      get: async () =>
        modelSettingsView.parse({
          version: configured ? 1 : 0,
          source: "administrator",
          planningModelId: "example-model",
          buildModelId: "example-model",
          models: ["example-model"],
          rules: {
            planning: { models: ["example-model"], allowOverride: true },
            build: { models: ["example-model"], allowOverride: true, reasoningEffort: "medium" },
          },
          connection: { configured, host: "models.example" },
        }),
      catalogue: async () => ({
        providers: [{ provider: "openai", label: "OpenAI", models: ["example-model"] }],
        connections: [
          {
            connectionID,
            provider: "openai",
            endpoint: "https://models.example/v1",
            version: 1,
            configured: true,
            pendingCommandID: null,
          },
        ],
        roles: [
          { role: "planning", active: null, check: null },
          {
            role: "build",
            active: configured ? { connectionID, version: 1, modelId: "example-model" } : null,
            check: null,
          },
        ],
        deployment: [],
      }),
      selectRole: async (_actor, input) => {
        expect(input).toMatchObject({
          role: "build",
          modelId: "example-model",
          reasoningEffort: "medium",
        });
        configured = true;
        checks++;
        return {
          status: "ready",
          modelId: "example-model",
          toolCall: true,
          structuredOutput: true,
          limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
        };
      },
    },
  });
  try {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await browserBootstrap(page);
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Managed model readiness','https://example.invalid/managed-model.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    created = true;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES(${ticketID},${projectID},'Ready after model setup','Show the exact total.','ready',${session.user.id})`;
    await createTicketDocumentController(database).save(ticketID, session.user.id, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "Ready after model setup",
      description: "Show the exact total.",
      requirement: {
        summary: "Show the exact total.",
        acceptanceCriteria: ["The total is visible."],
        nonGoals: [],
      },
    });
    await mockFactoryFunctions(page, {
      workspaces: {
        ensurePersonalSource: async () => {
          throw new CommandError("unavailable", "No runtime in this model settings fixture");
        },
        ensureEditor: async () => {
          throw new CommandError("unavailable", "No runtime in this model settings fixture");
        },
      },
    });
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.locator(".ticket-card-body").filter({ hasText: "Ready after model setup" }).click();
    const implement = page.getByRole("button", { name: "Implement", exact: true });
    await expect(implement).toBeDisabled();
    await expect(implement).toHaveAttribute("title", "Connect a Coding model in Settings first.");
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settings = page.getByRole("region", { name: "Settings", exact: true });
    await chooseSettingsPage(page, "Models", "Factory administration");
    const coding = settings.getByRole("region", { name: "Coding", exact: true });
    await coding.locator(".model-role-connection summary").click();
    await coding.getByLabel("Connection", { exact: true }).selectOption(connectionID);
    await coding.getByLabel("Model", { exact: true }).selectOption("example-model");
    await coding.getByRole("button", { name: "Save & check", exact: true }).click();
    await expect(
      coding.getByRole("status").filter({ hasText: "Model saved. Access checked." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Ticket", exact: true }).click();
    await expect(implement).toBeEnabled();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(checks).toBe(1);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    await mkdir(".factory/test-results/model-settings", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/model-settings/managed-coding-ready.png",
    });
  } finally {
    if (created) await deleteFactoryProject(projectID, database);
    await database.client.end();
  }
});
