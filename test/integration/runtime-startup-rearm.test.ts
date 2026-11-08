import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createDatabase } from "../../packages/db/src/client";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
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

test.each(["unprepared", "already-prepared", "stopping"] as const)(
  "Start retains the same personal attempt and only rearms a never-prepared startup: %s",
  async (scenario) => {
    const isolated = await ownedTestDatabase(server.identity, crypto.randomUUID());
    const previousURL = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = isolated.url;
    const database = createDatabase();
    if (previousURL === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousURL;
    try {
      const owned = await fixture(undefined, undefined, database);
      const workspaceID = personalWorkspaceIdentity(owned.projectID, owned.userID).workspaceID;
      const attemptID = crypto.randomUUID();
      await database.client`INSERT INTO factory.development_workspace(
        id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
        VALUES(${workspaceID},${owned.projectID},'personal',${owned.userID},'main',${"2".repeat(40)},${owned.userID})`;
      await database.client`INSERT INTO factory.runtime_attempt(
        id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,
        child_connector_token_hash,create_intended_at,created_by)
        VALUES(${attemptID},${owned.projectID},${workspaceID},1,${"2".repeat(40)},'create-intended',
          ${"a".repeat(64)},${"b".repeat(64)},now(),${owned.userID})`;
      await database.client`UPDATE factory.runtime_attempt SET state='starting',
        kubernetes_namespace_uid='namespace-uid',kubernetes_uid='worker-uid',
        failure='Factorybox startup deadline expired; original execution was retained'
        WHERE id=${attemptID}`;
      if (scenario === "already-prepared")
        await database.client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request) VALUES(${attemptID},'{}'::jsonb)`;
      if (scenario === "stopping")
        await database.client`UPDATE factory.runtime_attempt SET state='stop-intended',stop_intended_at=now() WHERE id=${attemptID}`;
      const hub = new RuntimeHub(async () => {});
      let observations = 0;
      let resourceReads = 0;
      const execution = createFactoryboxExecution(database, hub, async () => {
        throw new Error("No native command is allowed in this fixture");
      });
      const controller = createRuntimeController(
        database,
        hub,
        "owned-startup-secret",
        {
          async prepareExecution() {
            throw new Error("Start must not prepare new Source for an existing attempt");
          },
        },
        {
          ...createKubernetesClient(),
          async apply() {
            throw new Error("Start must not create a new worker or resources");
          },
          async getPod() {
            return {
              uid: "worker-uid",
              phase: "Running",
              ready: true,
              labels: {},
              imageIDs: [],
              artifacts: {},
              runtimeHostImage: "owned-runtime-host",
              factoryboxImage: "owned-worker",
            };
          },
        },
        async () => "",
        undefined,
        {
          ...execution,
          async startupResources() {
            resourceReads++;
            return [
              {
                kind: "Pod",
                metadata: { name: "owned-worker", namespace: "owned-namespace", labels: {} },
                spec: {},
              },
            ];
          },
          async hasExited() {
            return false;
          },
          async ensureStarted(id) {
            observations++;
            expect(id).toBe(attemptID);
            await database.client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request) VALUES(${attemptID},'{}'::jsonb) ON CONFLICT DO NOTHING`;
            await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${attemptID}`;
          },
        },
      );
      const result = await controller.start(owned.projectID, owned.userID);
      expect(result?.id).toBe(attemptID);
      if (scenario === "unprepared") {
        await eventually(
          async () => (await controller.get(attemptID))?.state,
          (state) => state === "ready",
          "Retained startup was not rearmed",
          5_000,
        );
        expect(observations).toBe(1);
        expect(resourceReads).toBe(1);
        expect((await controller.start(owned.projectID, owned.userID))?.id).toBe(attemptID);
        expect(observations).toBe(1);
      } else {
        expect(observations).toBe(0);
        expect(resourceReads).toBe(0);
      }
      const [identity] =
        await database.client`SELECT generation::float8 AS generation,parent_connector_token_hash,child_connector_token_hash,kubernetes_uid
        FROM factory.runtime_attempt WHERE id=${attemptID}`;
      expect(identity).toMatchObject({
        generation: 1,
        parent_connector_token_hash: "a".repeat(64),
        child_connector_token_hash: "b".repeat(64),
        kubernetes_uid: "worker-uid",
      });
      expect(
        await database.client`SELECT id FROM factory.runtime_attempt WHERE workspace_id=${workspaceID}`,
      ).toHaveLength(1);
    } finally {
      await database.client.end();
      await isolated.dispose();
    }
  },
  30_000,
);
