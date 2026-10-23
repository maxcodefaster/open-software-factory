import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { teardownFactoryProject } from "../support/factory-fixture";

const { FACTORY_ADMIN_EMAIL, FACTORY_ADMIN_PASSWORD, FACTORY_TEST_REPOSITORY_URL } = process.env;
const email = FACTORY_ADMIN_EMAIL ?? "admin@factory.local";
const password = FACTORY_ADMIN_PASSWORD ?? "factory-local-password";
const repositoryURL =
  FACTORY_TEST_REPOSITORY_URL ?? `file://${process.cwd()}/.factory/runtime-fixture-repository`;
const execute = promisify(execFile);
let testedProjectID = "";

async function command(arguments_: string[]) {
  const [executable, ...args] = arguments_;
  if (!executable) throw new Error("Command executable is required");
  const { stdout } = await execute(executable, args, { cwd: process.cwd() });
  return stdout.trim();
}

test.afterEach(async ({ context }) => {
  await teardownFactoryProject(context.request, testedProjectID);
  testedProjectID = "";
});

test("a live runtime recovers ready and ambiguous create state after Factory restarts", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(720_000);
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();

  await openProjectMenu(page);
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByLabel("Name").fill("Recovery fixture");
  const slug = `recovery-fixture-${crypto.randomUUID()}`;
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Repository URL").fill(repositoryURL);
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("Default branch").fill("main");
  await page.getByLabel("Dev Container").fill(".devcontainer/devcontainer.json");
  await page.getByRole("button", { name: "Register Project" }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toContainText(
    "Recovery fixture",
  );
  let projectID = "";
  await expect
    .poll(async () => {
      const response = await page.context().request.get("/api/projects");
      if (!response.ok()) return "";
      const projects = (await response.json()) as {
        projects: Array<{ id: string; slug: string }>;
      };
      projectID = projects.projects.find((value) => value.slug === slug)?.id ?? "";
      return projectID;
    })
    .not.toBe("");
  if (!projectID) throw new Error("Factory returned no registered Project");
  testedProjectID = projectID;

  await expect(page.getByRole("button", { name: "IDE", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(page.getByRole("link", { name: "Development app" })).toBeVisible({
    timeout: 300_000,
  });

  await expect
    .poll(
      async () => {
        const response = await page.context().request.get("/api/runtime-attempts");
        if (!response.ok()) return {};
        const body = (await response.json()) as {
          attempts: Array<{
            projectId: string;
            runtimeKind?: string;
            state: string;
          }>;
        };
        return Object.fromEntries(
          body.attempts
            .filter((value) => value.projectId === projectID)
            .map((value) => [value.runtimeKind, value.state]),
        );
      },
      { timeout: 300_000 },
    )
    .toMatchObject({ personal: "ready", staging: "ready" });

  const attemptsResponse = await page.context().request.get("/api/runtime-attempts");
  const attempts = (await attemptsResponse.json()) as {
    attempts: Array<{
      id: string;
      projectId: string;
      runtimeKind?: string;
      state: string;
    }>;
  };
  const attempt = attempts.attempts.find(
    (value) =>
      value.projectId === projectID && value.runtimeKind === "personal" && value.state === "ready",
  );
  const stagingAttempt = attempts.attempts.find(
    (value) =>
      value.projectId === projectID && value.runtimeKind === "staging" && value.state === "ready",
  );
  expect(attempt?.state).toBe("ready");
  expect(stagingAttempt?.state).toBe("ready");
  if (!attempt) throw new Error("Factory returned no Runtime Attempt");
  if (!stagingAttempt) throw new Error("Factory returned no Staging Runtime Attempt");

  let database = createDatabase(1);
  const identities = await database.client<
    Array<{ namespace: string; namespaceUID: string; podName: string; podUID: string }>
  >`
    SELECT kubernetes_namespace AS namespace,
      kubernetes_namespace_uid AS "namespaceUID",
      kubernetes_pod_name AS "podName", kubernetes_uid AS "podUID"
    FROM factory.runtime_attempt WHERE id = ${attempt.id}
  `;
  await database.client.end();
  const identity = identities[0];
  if (!identity?.namespaceUID || !identity.podUID) {
    throw new Error("Factory did not persist observed Kubernetes identity");
  }
  const statePath = `/home/coder/connector-state/${attempt.id}-1.json`;
  const connectorStateBefore = JSON.parse(
    await command([
      "kubectl",
      "--context",
      "orbstack",
      "exec",
      "-n",
      identity.namespace,
      identity.podName,
      "--",
      "cat",
      statePath,
    ]),
  ) as { containerId: string };
  expect(connectorStateBefore.containerId).toMatch(/^[0-9a-f]{64}$/);

  await command(["bun", "run", "factory:restart"]);
  await expect
    .poll(
      async () => {
        const response = await page.context().request.get("/api/runtime-attempts");
        if (!response.ok()) return "unavailable";
        const body = (await response.json()) as {
          attempts: Array<{ id: string; state: string }>;
        };
        return Object.fromEntries(
          body.attempts
            .filter((value) => [attempt.id, stagingAttempt.id].includes(value.id))
            .map((value) => [value.id, value.state]),
        );
      },
      { timeout: 30_000 },
    )
    .toMatchObject({ [attempt.id]: "ready", [stagingAttempt.id]: "ready" });

  const namespaceUIDAfter = await command([
    "kubectl",
    "--context",
    "orbstack",
    "get",
    "namespace",
    identity.namespace,
    "-o",
    "jsonpath={.metadata.uid}",
  ]);
  const podUIDAfter = await command([
    "kubectl",
    "--context",
    "orbstack",
    "get",
    "pod",
    identity.podName,
    "-n",
    identity.namespace,
    "-o",
    "jsonpath={.metadata.uid}",
  ]);
  const connectorStateAfter = JSON.parse(
    await command([
      "kubectl",
      "--context",
      "orbstack",
      "exec",
      "-n",
      identity.namespace,
      identity.podName,
      "--",
      "cat",
      statePath,
    ]),
  ) as { containerId: string };
  expect(namespaceUIDAfter).toBe(identity.namespaceUID);
  expect(podUIDAfter).toBe(identity.podUID);
  expect(connectorStateAfter.containerId).toBe(connectorStateBefore.containerId);

  database = createDatabase(1);
  await database.client`
    UPDATE factory.runtime_attempt SET state = 'create-intended', updated_at = now()
    WHERE id = ${attempt.id} AND state = 'ready'
  `;
  await database.client.end();
  await command(["bun", "run", "factory:restart"]);
  await expect
    .poll(
      async () => {
        const response = await page.context().request.get("/api/runtime-attempts");
        if (!response.ok()) return "unavailable";
        const body = (await response.json()) as {
          attempts: Array<{ id: string; state: string }>;
        };
        return body.attempts.find((value) => value.id === attempt.id)?.state ?? "missing";
      },
      { timeout: 30_000 },
    )
    .toBe("ready");

  const appPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Development app" }).click();
  const appPage = await appPagePromise;
  await expect(appPage.getByRole("heading", { name: "Runtime fixture ready" })).toBeVisible();
  await appPage.close();

  await Promise.all([
    page.context().request.post(`/api/runtime-attempts/${attempt.id}/stop`, {
      headers: { origin: "http://127.0.0.1:3000" },
    }),
    page.context().request.post(`/api/runtime-attempts/${attempt.id}/stop`, {
      headers: { origin: "http://127.0.0.1:3000" },
    }),
  ]);
  await expect
    .poll(
      async () => {
        const response = await page.context().request.get("/api/runtime-attempts");
        const body = (await response.json()) as {
          attempts: Array<{ id: string; state: string }>;
        };
        return body.attempts.find((value) => value.id === attempt.id)?.state;
      },
      { timeout: 180_000 },
    )
    .toBe("stopped");
  expect(
    await command([
      "kubectl",
      "--context",
      "orbstack",
      "get",
      "namespace",
      identity.namespace,
      "-o",
      "name",
    ]),
  ).toBe(`namespace/${identity.namespace}`);
  await expect
    .poll(
      () =>
        command([
          "kubectl",
          "--context",
          "orbstack",
          "get",
          "pod",
          identity.podName,
          "-n",
          identity.namespace,
          "--ignore-not-found",
          "-o",
          "name",
        ]),
      { timeout: 30_000 },
    )
    .toBe("");
  await expect(
    access(`/tmp/open-software-factory-runtime-sources/${attempt.id}`).then(
      () => true,
      () => false,
    ),
  ).resolves.toBe(false);
});
