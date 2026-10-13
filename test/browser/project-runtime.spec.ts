import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { teardownFactoryProject } from "../support/factory-fixture";

const { FACTORY_ADMIN_EMAIL, FACTORY_ADMIN_PASSWORD } = process.env;
const email = FACTORY_ADMIN_EMAIL ?? "admin@factory.local";
const password = FACTORY_ADMIN_PASSWORD ?? "factory-local-password";
const execute = promisify(execFile);
let testedProjectID = "";

test.afterEach(async ({ context }) => {
  await teardownFactoryProject(context.request, testedProjectID);
  testedProjectID = "";
});

test("an unsafe System Contract fails before Kubernetes create", async ({ page }) => {
  const projectID = crypto.randomUUID();
  const repository = { owner: "factory-mutation", name: `unsafe-contract-${projectID}` };
  const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
  const apiURL = "http://127.0.0.1:33030/api/v1/";
  const forge = createForgejoClient({ apiURL, token });
  const database = createDatabase(1);
  let created = false;
  try {
    await forge.createSetupRepository({ repository, setupID: projectID });
    created = true;
    await forge.createSetupFiles({
      repository,
      setupID: projectID,
      branch: "main",
      files: [
        {
          path: ".factory/system.json",
          content: JSON.stringify({
            version: 1,
            primaryApp: "web",
            apps: [
              {
                id: "web",
                label: "Web",
                command: ["sh", "-c", "node src/server.mjs"],
                port: 4_300,
                healthPath: "/health",
              },
            ],
          }),
        },
      ],
    });

    await page.goto("/");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();

    const { session } = await (await page.request.get("/api/session")).json();
    // Only planning fixture state is seeded. The authenticated runtime command
    // must inspect the real exact-commit Forgejo file before creating anything.
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${repository.name},'Unsafe contract fixture',${`http://127.0.0.1:33030/${repository.owner}/${repository.name}.git`},'main','.devcontainer/devcontainer.json',${session.user.id})`;
    const project = { id: projectID };
    testedProjectID = projectID;

    const startResponse = await page
      .context()
      .request.post(`/api/projects/${project.id}/personal-workspace/ensure`, {
        headers: { origin: "http://127.0.0.1:3000" },
      });
    expect(startResponse.status()).toBe(422);
    await expect(startResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining("cannot use a shell command string"),
    });

    const attemptsResponse = await page.context().request.get("/api/runtime-attempts");
    const attempts = (await attemptsResponse.json()) as {
      attempts: Array<{ projectId: string }>;
    };
    expect(attempts.attempts.filter((attempt) => attempt.projectId === project.id)).toEqual([]);
    const { stdout } = await execute(
      "kubectl",
      [
        "--context",
        "orbstack",
        "get",
        "namespace",
        "-l",
        `factory.dev/project=${project.id}`,
        "-o",
        "name",
      ],
      { cwd: process.cwd() },
    );
    expect(stdout.trim()).toBe("");
  } finally {
    await database.client.end();
    if (created) {
      expect(await forge.setupRepository(repository, projectID)).not.toBeNull();
      expect(
        (
          await fetch(`${apiURL}repos/${repository.owner}/${repository.name}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          })
        ).ok,
      ).toBe(true);
    }
  }
});
