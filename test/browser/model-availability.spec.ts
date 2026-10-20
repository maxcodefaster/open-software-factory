import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createDatabase } from "../../packages/db/src/client";
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
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, modelRelayConfigured: configured } });
  });
  await page.route("**/api/model-settings", (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route("**/api/model-connections", (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route("**/api/model-connections/role", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      role: "build",
      modelId: "example-model",
      reasoningEffort: "medium",
    });
    configured = true;
    checks++;
    await route.fulfill({
      json: {
        status: "ready",
        modelId: "example-model",
        toolCall: true,
        structuredOutput: true,
        limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
      },
    });
  });
  try {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await (await page.request.get("/api/session")).json();
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
    for (const action of ["source-workspace", "developer-ide"])
      await page.route(`**/api/projects/${projectID}/${action}/ensure`, (route) =>
        route.fulfill({
          status: 503,
          json: { error: "No runtime in this model settings fixture" },
        }),
      );
    await page.getByRole("button", { name: "Open project menu", exact: true }).click();
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.locator(".ticket-card-body").filter({ hasText: "Ready after model setup" }).click();
    const implement = page.getByRole("button", { name: "Implement", exact: true });
    await expect(implement).toBeDisabled();
    await expect(implement).toHaveAttribute("title", "Connect a Coding model in Settings first.");
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settings = page.getByRole("region", { name: "Settings", exact: true });
    await settings
      .getByRole("navigation", { name: "Settings navigation" })
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Factory", exact: true }) })
      .getByRole("button", { name: "Models", exact: true })
      .click();
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
