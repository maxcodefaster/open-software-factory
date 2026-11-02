import { expect, test } from "bun:test";
import { z } from "zod";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createProjectPreparation } from "../../apps/factory/src/runtime/project-preparation";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import {
  installOwnedRuntimeConfiguration,
  ownedFactoryboxProfile,
  ownedRuntimeConfiguration,
} from "../fixtures/runtime-configuration";
import { fixtureValue } from "../fixtures/value";

test("automatic preparation coalesces exact jobs, bounds producers and fences results to runtime environment", async () => {
  const process = await factoryProcess();
  const database = process.connect(1);
  try {
    const token = "owned-preparation-token";
    const owned = await fixture(undefined, undefined, database, token);
    let head = "a".repeat(40);
    const started: string[] = [];
    const preparation = createProjectPreparation({
      database,
      head: async () => head,
      start: async (id) => {
        started.push(id);
        await database.client`UPDATE factory.project_image_preparation SET state='running' WHERE id=${id}`;
      },
    });
    await preparation.ensure(owned.projectID);
    await preparation.ensure(owned.projectID);
    expect(await database.client`SELECT id FROM factory.project_image_preparation`).toHaveLength(2);
    head = "b".repeat(40);
    await preparation.ensure(owned.projectID);
    await Promise.all([preparation.drain(), preparation.drain()]);
    expect(started).toHaveLength(1);
    const preparationID = started[0];
    if (!preparationID) throw new Error("Preparation did not start");
    expect(
      (
        await database.client<
          { revision: string }[]
        >`SELECT revision FROM factory.project_image_preparation WHERE id=${preparationID}`
      )[0]?.revision,
    ).toBe(head);
    await preparation.drain();
    expect(started).toHaveLength(1);
    await database.client`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${owned.attemptID}`;
    await freezeRuntimeEnvironment(database.client, owned.attemptID);
    const request = (method = "GET", body?: unknown, authorization = token) =>
      new Request(`https://factory.test/internal/project-image/${owned.attemptID}`, {
        method,
        headers: {
          authorization: `Bearer ${authorization}`,
          "x-factory-runtime-generation": "1",
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect(
      (await preparation.endpoint(request("GET", undefined, "wrong"), owned.attemptID)).status,
    ).toBe(401);
    expect(await (await preparation.endpoint(request(), owned.attemptID)).json()).toBeNull();
    expect(
      (
        await preparation.endpoint(
          request("POST", {
            identity: "a".repeat(64),
            image: `registry.test/project@sha256:${"a".repeat(64)}`,
          }),
          owned.attemptID,
        )
      ).status,
    ).toBe(401);
    // Only a genuine producer for matching frozen inputs may publish a result.
    const producerID = crypto.randomUUID();
    const [job] = await database.client<
      Array<{ environment: "development" | "main-preview" }>
    >`SELECT environment FROM factory.project_image_preparation WHERE id=${preparationID}`;
    if (!job) throw new Error("Missing producer job");
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${producerID},${owned.projectID},'prebuild',2,${head},'create-intended',${fixtureValue((await database.client<{ hash: string }[]>`SELECT parent_connector_token_hash AS hash FROM factory.runtime_attempt WHERE id=${owned.attemptID}`)[0], "(await database.client<{ hash: string }[]>`SELECT parent_connector_token_hash AS hash FROM factory.runtime_attempt WHERE").hash},${"c".repeat(64)},now(),${owned.userID})`;
    await database.client`UPDATE factory.project_image_preparation SET runtime_attempt_id=${producerID} WHERE id=${preparationID}`;
    await freezeRuntimeArtifacts(database.client, producerID, {
      factoryboxProfile: ownedFactoryboxProfile,
      hostImages: {
        development: `registry.test/runtime@sha256:${"d".repeat(64)}`,
        build: undefined,
        verification: undefined,
        staging: undefined,
      },
      browserToolsImage: undefined,
    });
    const result = {
      identity: "a".repeat(64),
      image: `registry.test/open-factory/prebuilds/${owned.projectID}@sha256:${"c".repeat(64)}`,
    };
    const producerRequest = (body: unknown) => {
      const value = request("POST", body);
      value.headers.set("x-factory-runtime-generation", "2");
      return value;
    };
    expect((await preparation.endpoint(producerRequest(result), producerID)).status).toBe(204);
    await preparation.drain();
    expect(started).toHaveLength(1);
    expect((await preparation.endpoint(producerRequest(result), producerID)).status).toBe(204);
    expect(
      (
        await preparation.endpoint(
          producerRequest({ ...result, identity: "b".repeat(64) }),
          producerID,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await preparation.endpoint(
          producerRequest({ ...result, image: `registry.test/other@sha256:${"c".repeat(64)}` }),
          producerID,
        )
      ).status,
    ).toBe(401);
    // A result from another revision never becomes this runtime's cache input.
    expect(await (await preparation.endpoint(request(), owned.attemptID)).json()).toBeNull();
    await database.client`UPDATE factory.runtime_attempt SET stop_intended_at=now() WHERE id=${owned.attemptID}`;
    expect((await preparation.endpoint(request(), owned.attemptID)).status).toBe(401);
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);

test("automatic image preparation starts its admitted native Sandbox after observing the worker", async () => {
  const restore = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const resources = z.object({
    kind: z.string(),
    metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()) }),
  });
  let manifest: z.output<typeof resources>[] = [];
  let exists = false;
  let namespaceExists = false;
  const starts: string[] = [];
  const hub = new RuntimeHub(async () => {});
  const ready = Promise.withResolvers<void>();
  const controller = createRuntimeController(
    database,
    hub,
    "owned-prebuild-startup-secret",
    {
      prepareExecution: async () => {
        throw new Error("Prebuild must not mount canonical Source");
      },
    },
    {
      ...createKubernetesClient(),
      async apply(input) {
        const incoming = input.map((item) => resources.parse(item));
        manifest = [
          ...new Map(
            [...manifest, ...incoming].map((item) => [`${item.kind}/${item.metadata.name}`, item]),
          ).values(),
        ];
        exists ||= incoming.some((item) => item.kind === "Pod");
        namespaceExists ||= incoming.some((item) => item.kind === "Namespace");
        return {
          namespaceUID: "owned-prebuild-namespace",
          sharedUIDs: Object.fromEntries(
            manifest
              .filter((item) => item.metadata.labels["factory.dev/shared-resource"] === "true")
              .map((item) => [
                `${item.kind}/${item.metadata.name}`,
                item.kind === "Pod"
                  ? "owned-prebuild-pod"
                  : `owned-${item.kind}-${item.metadata.name}`,
              ]),
          ),
        };
      },
      async getNamespace() {
        return namespaceExists
          ? {
              uid: "owned-prebuild-namespace",
              labels: manifest.find((item) => item.kind === "Namespace")?.metadata.labels ?? {},
            }
          : null;
      },
      async getPod() {
        return exists
          ? {
              uid: "owned-prebuild-pod",
              phase: "Running",
              ready: true,
              labels: manifest.find((item) => item.kind === "Pod")?.metadata.labels ?? {},
              factoryboxImage: ownedRuntimeConfiguration.FACTORY_FACTORYBOX_WORKER_IMAGE,
              runtimeHostImage: ownedRuntimeConfiguration.FACTORY_RUNTIME_HOST_IMAGE,
            }
          : null;
      },
    },
    async () => "",
    undefined,
    {
      ...createFactoryboxExecution(database, hub),
      hasExited: async () => false,
      async ensureStarted(attemptID) {
        starts.push(attemptID);
        // Settle this owned controller observation without claiming a native
        // execution or creating a Connector/model session in this test.
        await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${attemptID}`;
        ready.resolve();
      },
    },
  );
  try {
    const owned = await fixture(undefined, undefined, database);
    const preparation = createProjectPreparation({
      database,
      head: async () => "d".repeat(40),
      start: (id) => controller.startProjectPrebuild(id),
    });
    await preparation.ensure(owned.projectID);
    await preparation.drain();
    const [job] = await database.client<{ attemptID: string }[]>`
      SELECT runtime_attempt_id AS "attemptID" FROM factory.project_image_preparation
      WHERE project_id=${owned.projectID} AND state='running'`;
    if (!job) throw new Error("Missing commissioned image producer");
    await eventually(
      async () => starts,
      (value) => value.includes(job.attemptID),
      "Image producer observed its worker but never started the native Sandbox",
      3_000,
    );
    await ready.promise;
    expect(starts).toEqual([job.attemptID]);
    expect((await controller.get(job.attemptID))?.state).toBe("stopped");
  } finally {
    await database.client`UPDATE factory.runtime_attempt SET state='stopped'
      WHERE isolated_kind='prebuild' AND state IN ('create-intended','starting')`;
    await Bun.sleep(1_100);
    await database.client.end({ timeout: 2 });
    await host.dispose();
    restore();
  }
}, 60_000);

test.each(["complete Stop", "confirmed native Delete", "foreign native Delete"] as const)(
  "restarted preparation expires old producers and waits for %s before next admission",
  async (teardown) => {
    const process = await factoryProcess();
    const database = process.connect();
    try {
      const owned = await fixture(undefined, undefined, database);
      const head = "e".repeat(40);
      const started: string[] = [];
      const expired: string[] = [];
      const input = {
        database,
        head: async () => head,
        start: async (id: string) => {
          started.push(id);
        },
        expire: async (id: string) => {
          expired.push(id);
          await database.client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${id}`;
        },
      };
      await createProjectPreparation(input).ensure(owned.projectID);
      const [job] = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.project_image_preparation ORDER BY environment LIMIT 1`;
      if (!job) throw new Error("Missing owned preparation");
      const producerID = crypto.randomUUID();
      await database.client`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${producerID},${owned.projectID},'prebuild',2,${head},'create-intended',${"a".repeat(64)},${"b".repeat(64)},now()-interval '13 minutes',${owned.userID})`;
      await database.client`UPDATE factory.project_image_preparation SET state='running',runtime_attempt_id=${producerID},updated_at=now()-interval '13 minutes' WHERE id=${job.id}`;
      if (teardown !== "complete Stop") {
        await database.client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${producerID}`;
        await database.client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request)
        VALUES(${producerID},${JSON.stringify({ sandboxID: `runtime-${producerID.replaceAll("-", "")}` })}::text::jsonb)`;
      }
      const restarted = createProjectPreparation(input);
      await restarted.drain();
      expect(expired).toEqual([producerID]);
      expect(started).toEqual([]);
      await restarted.drain();
      expect(expired).toEqual([producerID]);
      expect(started).toEqual([]);
      if (teardown === "complete Stop") {
        await database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now() WHERE id=${producerID}`;
      } else {
        await database.client`INSERT INTO factory.factorybox_lifecycle_operation(runtime_attempt_id,action,attempted_at,completed_at,observation)
        VALUES(${producerID},'delete',now(),now(),${JSON.stringify({
          version: 1,
          id:
            teardown === "foreign native Delete"
              ? "runtime-foreign"
              : `runtime-${producerID.replaceAll("-", "")}`,
          phase: "deleted",
          owner: "d".repeat(32),
          inputSHA256: "e".repeat(64),
        })}::text::jsonb)`;
      }
      await restarted.drain();
      if (teardown === "foreign native Delete") {
        expect(started).toEqual([]);
        expect(
          (
            await database.client<{ state: string }[]>`
          SELECT state FROM factory.project_image_preparation WHERE id=${job.id}`
          )[0]?.state,
        ).toBe("running");
        return;
      }
      expect(started).toHaveLength(1);
      expect(
        (
          await database.client<
            Array<{ state: string }>
          >`SELECT state FROM factory.project_image_preparation WHERE id=${job.id}`
        )[0]?.state,
      ).toBe("failed");
      if (teardown === "confirmed native Delete") {
        expect(
          (
            await database.client<{ state: string }[]>`
        SELECT state FROM factory.runtime_attempt WHERE id=${producerID}`
          )[0]?.state,
        ).toBe("stopping");
        expect(
          (
            await database.client`SELECT id FROM factory.factorybox_lifecycle_operation
        WHERE runtime_attempt_id=${producerID} AND action='retire-sandbox' AND completed_at IS NOT NULL`
          ).length,
        ).toBe(0);
      }
    } finally {
      await database.client.end();
      await process.dispose();
    }
  },
  60_000,
);
