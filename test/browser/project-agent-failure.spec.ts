import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test("an uncertain background Interview stays visible without resending inference", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const slug = `interview-failure-${projectID.slice(0, 8)}`;
  const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
  const [user] = await database.client<
    { id: string }[]
  >`SELECT id FROM auth."user" WHERE email=${email}`;
  if (!user) throw new Error("Test administrator is unavailable");
  let inferenceRequests = 0;
  try {
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES (${projectID},${slug},'Interview failure fixture','http://127.0.0.1:33030/fixture/unused.git','main','.devcontainer/devcontainer.json',${user.id})`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES (${ticketID},${projectID},'Interrupted interview','Retain this intent.','ready',${user.id})`;
    await page.route(`**/api/projects/${projectID}/conversation**`, async (route) => {
      if (route.request().method() !== "GET") inferenceRequests++;
      await route.fulfill({
        json: {
          id: crypto.randomUUID(),
          projectId: projectID,
          ticketId: ticketID,
          mode: "plan",
          version: 1,
          entries: [],
          turn: {
            id: crypto.randomUUID(),
            commandId: crypto.randomUUID(),
            state: "uncertain",
            engine: "mastra",
            mode: "plan",
            modelId: "fixture-model",
            skills: [],
            summary: "The provider outcome could not be established.",
          },
        },
      });
    });
    await signIn(page);
    await page.getByRole("button", { name: "Open project menu", exact: true }).click();
    await page
      .getByRole("region", { name: "Projects", exact: true })
      .getByRole("button")
      .filter({ hasText: slug })
      .click();
    await page.getByRole("button").filter({ hasText: "Interrupted interview" }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Agent panel" });
    await expect(panel.getByRole("alert")).toContainText("no request was resent", {
      timeout: 2000,
    });
    await expect(panel.getByRole("alert")).toContainText("could not confirm");
    await expect(panel.getByRole("alert")).toContainText("separate AI request");
    await expect(panel.getByLabel("Message conversation")).toBeVisible();
    expect(inferenceRequests).toBe(0);
  } finally {
    await deleteFactoryProject(projectID, database);
    await database.client.end();
  }
});
