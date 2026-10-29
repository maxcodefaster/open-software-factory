import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createDatabase } from "../../packages/db/src/client";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
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

test.each(["personal", "staging", "ticket"] as const)(
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
      const attempt =
        kind === "personal"
          ? await controller.start(owned.projectID, owned.userID)
          : kind === "staging"
            ? await controller.ensureStaging(owned.projectID, owned.userID)
            : await controller.startPersisted(owned.changeID, owned.userID);
      expect(attempt?.state).toBe("create-intended");
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
