import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { createDatabase } from "../../packages/db/src/client";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import {
  installOwnedRuntimeConfiguration,
  ownedRuntimeConfiguration,
} from "../fixtures/runtime-configuration";

const origin = "https://factory.example";
let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
let restore: () => void;
let previousOrigin: string | undefined;
let previousSecret: string | undefined;
beforeAll(async () => {
  restore = installOwnedRuntimeConfiguration();
  previousOrigin = process.env["FACTORY_BASE_URL"];
  previousSecret = process.env["FACTORY_AUTH_SECRET"];
  process.env["FACTORY_AUTH_SECRET"] = "owned-public-origin-signing-secret-0123456789";
  server = process.env["FACTORY_TEST_POSTGRES"]
    ? { identity: JSON.parse(process.env["FACTORY_TEST_POSTGRES"]), dispose: async () => {} }
    : await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
  restore?.();
  if (previousOrigin === undefined) delete process.env["FACTORY_BASE_URL"];
  else process.env["FACTORY_BASE_URL"] = previousOrigin;
  if (previousSecret === undefined) delete process.env["FACTORY_AUTH_SECRET"];
  else process.env["FACTORY_AUTH_SECRET"] = previousSecret;
});

const resource = z
  .object({
    kind: z.string(),
    metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()) }),
    stringData: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const assignment = z.object({
  runtimeAttemptId: z.string(),
  processes: z.array(
    z.object({ name: z.string(), env: z.record(z.string(), z.string()).optional() }),
  ),
});

for (const recovered of [false, true])
  test.each(["personal", "staging", "ticket"] as const)(
    `${recovered ? "capacity recovery" : "normal startup"} delivers frozen published origins to %s App processes`,
    async (kind) => {
      const isolated = await ownedTestDatabase(server.identity, crypto.randomUUID());
      const previousURL = process.env["DATABASE_URL"];
      process.env["DATABASE_URL"] = isolated.url;
      const database = createDatabase();
      if (previousURL === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previousURL;
      const source = await mkdtemp(join(tmpdir(), "factory-app-origins-"));
      const hub = new RuntimeHub(async () => {});
      let controller: ReturnType<typeof createRuntimeController> | undefined;
      let attemptID: string | undefined;
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
            ],
          }),
        );
        const git = (...args: string[]) => {
          const result = Bun.spawnSync(["git", "-C", source, ...args]);
          if (result.exitCode) throw new Error("Owned App origins source setup failed");
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
          "Owned published Apps",
        );
        const owned = await fixture(undefined, git("rev-parse", "HEAD"), database);
        await database.client`UPDATE factory.project SET repository_url=${`file://${source}`}
          WHERE id=${owned.projectID}`;
        await database.client`UPDATE factory.runtime_attempt SET state='stopped'
          WHERE id=${owned.attemptID}`;
        if (kind === "ticket")
          await database.client`INSERT INTO factory.branch_create_operation(
            id,change_id,repository_owner,repository_name,branch_name,start_sha,
            idempotency_key,state,observed_head_sha,completed_at)
            SELECT ${crypto.randomUUID()},id,'owned','app-origins',branch_name,base_sha,
              ${crypto.randomUUID()},'succeeded',base_sha,now()
            FROM factory.change WHERE id=${owned.changeID}`;
        if (recovered)
          await database.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
            VALUES('factory',1,'{"sandboxes":0}'::jsonb,${owned.userID})`;
        const resources = new Map<string, z.infer<typeof resource>>();
        const kubernetes = {
          ...createKubernetesClient(),
          async apply(values: readonly unknown[]) {
            const parsed = values.map((value) => resource.parse(value));
            for (const value of parsed)
              resources.set(`${value.kind}/${value.metadata.name}`, value);
            return {
              namespaceUID: "owned-namespace",
              sharedUIDs: Object.fromEntries(
                parsed
                  .filter(
                    (value) => value.metadata.labels["factory.dev/shared-resource"] === "true",
                  )
                  .map((value) => [
                    `${value.kind}/${value.metadata.name}`,
                    value.kind === "Pod" ? "owned-pod" : `owned-${value.metadata.name}`,
                  ]),
              ),
            };
          },
          async getNamespace() {
            const value = [...resources.values()].find((value) => value.kind === "Namespace");
            return value ? { uid: "owned-namespace", labels: value.metadata.labels } : null;
          },
          async getPod() {
            const value = [...resources.values()].find((value) => value.kind === "Pod");
            return value
              ? {
                  uid: "owned-pod",
                  phase: "Running",
                  ready: true,
                  labels: value.metadata.labels,
                  factoryboxImage: ownedRuntimeConfiguration.FACTORY_FACTORYBOX_WORKER_IMAGE,
                  runtimeHostImage: ownedRuntimeConfiguration.FACTORY_RUNTIME_HOST_IMAGE,
                }
              : null;
          },
          async readSecret(_namespace: string, name: string, key: string) {
            const value = resources.get(`Secret/${name}`)?.stringData?.[key];
            if (value === undefined) throw new Error("Owned assignment Secret missing");
            return value;
          },
        };
        hub.ready = () => true;
        const makeController = () =>
          createRuntimeController(
            database,
            hub,
            "owned-published-origins",
            {
              async prepareExecution() {
                return {
                  workspaceID: owned.workspaceID,
                  namespaceUID: "owned-namespace",
                  claimUID: "owned-runtime-data",
                  storageNode: "owned-node",
                };
              },
            },
            kubernetes,
            async () => "",
            undefined,
            {
              ...createFactoryboxExecution(database, hub),
              async ensureStarted() {},
            },
          );
        process.env["FACTORY_BASE_URL"] = origin;
        controller = makeController();
        const created =
          kind === "personal"
            ? await controller.start(owned.projectID, owned.userID)
            : kind === "staging"
              ? await controller.ensureStaging(owned.projectID, owned.userID)
              : await controller.startPersisted(owned.changeID, owned.userID);
        if (!created) throw new Error("Owned runtime was not admitted");
        attemptID = created.id;
        if (recovered) {
          expect(created.state).toBe("create-intended");
          expect([...resources.values()].some((value) => value.kind === "Secret")).toBe(false);
          await database.client`DELETE FROM factory.execution_policy WHERE scope='factory'`;
          process.env["FACTORY_BASE_URL"] = "https://changed.example";
          controller = makeController();
          await controller.drainComputeWaits();
        }
        const currentController = controller;
        await eventually(
          () => currentController.get(created.id),
          (value) => value?.state === "ready",
          "Owned runtime startup did not settle",
        );
        const value = [...resources.values()].find(
          (value) => value.stringData?.["assignment.json"],
        );
        const saved = assignment.parse(JSON.parse(value?.stringData?.["assignment.json"] ?? "{}"));
        expect(saved.runtimeAttemptId).toBe(created.id);
        const expected = {
          "4321": appRuntimeOrigin(origin, created.id, "app"),
          "3002": appRuntimeOrigin(origin, created.id, "app-editor"),
        };
        for (const name of ["app", "app-editor"]) {
          const app = saved.processes.find((process) => process.name === name);
          expect(app).toBeDefined();
          expect(app?.env?.["FACTORY_APP_ORIGINS"]).toBe(JSON.stringify(expected));
        }
        for (const process of saved.processes.filter((process) => !process.name.startsWith("app")))
          expect(process.env?.["FACTORY_APP_ORIGINS"]).toBeUndefined();
        const [artifact] = await database.client<{ origin: string }[]>`
          SELECT public_factory_origin AS origin FROM factory.runtime_artifact_intent
          WHERE runtime_attempt_id=${created.id}`;
        expect(artifact?.origin).toBe(origin);
      } finally {
        if (attemptID) {
          await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${attemptID}`;
          hub.revoke(attemptID);
          // The startup observer rechecks state after its one-second cadence.
          // Let that owned observer exit before disposing its database.
          await Bun.sleep(1_100);
        }
        await database.client.end();
        await isolated.dispose();
        await rm(source, { recursive: true, force: true });
      }
    },
    30_000,
  );
