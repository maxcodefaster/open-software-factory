import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createDatabase } from "../../packages/db/src/client";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
let restore: () => void;
beforeAll(async () => {
  restore = installOwnedRuntimeConfiguration();
  server = process.env["FACTORY_TEST_POSTGRES"]
    ? { identity: JSON.parse(process.env["FACTORY_TEST_POSTGRES"]), dispose: async () => {} }
    : await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
  restore?.();
});

test.each([
  "personal",
  "staging",
  "staging-unstarted",
  "staging-missing-contract",
  "ticket",
] as const)(
  "new %s runtime retains all declared App channels before compute is available",
  async (kind) => {
    const isolated = await ownedTestDatabase(server.identity, crypto.randomUUID());
    const previousURL = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = isolated.url;
    const database = createDatabase();
    if (previousURL === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousURL;
    const source = await mkdtemp(join(tmpdir(), "factory-declared-apps-"));
    try {
      await mkdir(join(source, ".factory"));
      await writeFile(
        join(source, ".factory/system.json"),
        JSON.stringify({
          version: 1,
          primaryApp: "web",
          apps: [
            {
              id: "web",
              label: "Website",
              command: ["node", "web.js"],
              port: 4321,
              healthPath: "/",
            },
            {
              id: "editor",
              label: "Forms editor",
              command: ["node", "editor.js"],
              port: 3002,
              healthPath: "/",
            },
            {
              id: "api",
              label: "Forms API",
              command: ["node", "api.js"],
              port: 3001,
              healthPath: "/",
            },
          ],
        }),
      );
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", "-C", source, ...args]);
        if (result.exitCode) throw new Error("Owned declared-App source setup failed");
        return result.stdout.toString().trim();
      };
      git("init", "-b", "main");
      git("add", ".");
      git(
        "-c",
        "user.name=Factory",
        "-c",
        "user.email=factory@example.invalid",
        "commit",
        "-m",
        "Owned declared Apps",
      );
      if (kind === "staging-missing-contract") {
        git("rm", ".factory/system.json");
        git(
          "-c",
          "user.name=Factory",
          "-c",
          "user.email=factory@example.invalid",
          "commit",
          "-m",
          "Owned source before configuration",
        );
      }
      const revision = git("rev-parse", "HEAD");
      const owned = await fixture(undefined, revision, database);
      await database.client`UPDATE factory.project SET repository_url=${`file://${source}`}
        WHERE id=${owned.projectID}`;
      await database.client`UPDATE factory.runtime_attempt SET state='stopped'
        WHERE id=${owned.attemptID}`;
      await database.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
        VALUES('factory',1,'{"sandboxes":0}'::jsonb,${owned.userID})`;
      if (kind === "ticket")
        await database.client`INSERT INTO factory.branch_create_operation(
          id,change_id,repository_owner,repository_name,branch_name,start_sha,
          idempotency_key,state,observed_head_sha,completed_at)
          SELECT ${crypto.randomUUID()},id,'owned','declared-apps',branch_name,base_sha,
            ${crypto.randomUUID()},'succeeded',base_sha,now()
          FROM factory.change WHERE id=${owned.changeID}`;
      const controller = createRuntimeController(
        database,
        new RuntimeHub(async () => {}),
        "owned-declared-app-secret",
        {
          async prepareExecution() {
            throw new Error("Queued compute must not prepare source");
          },
        },
        {
          ...createKubernetesClient(),
          async apply() {
            throw new Error("Queued compute must not create resources");
          },
        },
        async () => "",
      );
      if (kind === "staging-missing-contract") {
        await expect(controller.ensureStaging(owned.projectID, owned.userID)).rejects.toThrow(
          ".factory/system.json",
        );
        expect(
          await database.client`SELECT project_id FROM factory.staging_preview WHERE project_id=${owned.projectID}`,
        ).toHaveLength(0);
        return;
      }
      if (kind === "staging-unstarted")
        await database.client`INSERT INTO factory.staging_preview(project_id,revision)
          VALUES(${owned.projectID},${"0".repeat(40)})`;
      const attempt =
        kind === "personal"
          ? await controller.start(owned.projectID, owned.userID)
          : kind.startsWith("staging")
            ? await controller.ensureStaging(owned.projectID, owned.userID)
            : await controller.startPersisted(owned.changeID, owned.userID);
      expect(attempt?.state).toBe("create-intended");
      expect(attempt?.revision).toBe(revision);
      const [retained] = await database.client<{ apps: string[]; waiting: boolean }[]>`
        SELECT declared_apps AS apps,
          EXISTS(SELECT 1 FROM factory.runtime_compute_wait WHERE attempt_id=attempt.id) AS waiting
        FROM factory.runtime_attempt attempt WHERE id=${attempt?.id ?? null}`;
      expect(retained?.apps).toEqual(["app", "app-editor", "app-api"]);
      expect(retained?.waiting).toBe(true);
    } finally {
      await database.client.end();
      await isolated.dispose();
      await rm(source, { recursive: true, force: true });
    }
  },
  30_000,
);

test("terminal bootstrap failure is not hidden by an earlier observation timeout", async () => {
  const isolated = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = isolated.url;
  const database = createDatabase();
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.runtime_attempt
      SET failure='Infrastructure command timed out; outcome is unconfirmed'
      WHERE id=${owned.attemptID}`;
    const controller = createRuntimeController(
      database,
      new RuntimeHub(async () => {}),
      "owned-terminal-cause",
      {
        async prepareExecution() {
          throw new Error("Status must not prepare source");
        },
      },
      {
        ...createKubernetesClient(),
        getNamespace: async () => null,
        getPod: async () => null,
        deleteSecret: async () => {},
      },
      async () => "",
    );
    const cause = "Dev Container build failed: actual bootstrap cause";
    await controller.status(owned.attemptID, "failed", cause);
    await eventually(
      async () => (await controller.get(owned.attemptID))?.state,
      (state) => state === "failed",
      "Owned terminal cleanup did not finish",
    );
    expect((await controller.get(owned.attemptID))?.failure).toBe(cause);
  } finally {
    await database.client.end();
    await isolated.dispose();
  }
}, 30_000);
