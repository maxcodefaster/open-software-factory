import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type { StoredEnvironment } from "../../apps/factory/src/environments/openbao";
import { createEnvironmentService } from "../../apps/factory/src/environments/service";
import { createProjectPreparation } from "../../apps/factory/src/runtime/project-preparation";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";
import { substrateFixture } from "../fixtures/substrate";

test("imported preparation admission without explicit intent stays setup-gated before resolving inputs", async () => {
  const f = await substrateFixture();
  let heads = 0;
  let starts = 0;
  try {
    await f.database
      .client`INSERT INTO factory.project_repository_intent(command_id,setup_id,user_id,project_id,name,slug,kind,source_url,fingerprint,state)
      VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${f.userID},${f.projectID},'Owned import',${`native-${f.projectID}`},'import',
        'https://example.invalid/import.git',${"a".repeat(64)},'committed')`;
    const preparation = createProjectPreparation({
      database: f.database,
      head: async () => {
        heads++;
        return "a".repeat(40);
      },
      start: async () => {
        starts++;
      },
    });
    await expect(preparation.ensure(f.projectID)).rejects.toThrow(
      "Confirm this Project's configuration",
    );
    await preparation.drain();
    expect(heads).toBe(0);
    expect(starts).toBe(0);
    expect(await f.database.client`SELECT id FROM factory.project_image_preparation`).toHaveLength(
      0,
    );
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("an exact committed development settings save prepares only development without Factory configuration", async () => {
  const f = await substrateFixture();
  const stored = new Map<string, StoredEnvironment>();
  const admitted: string[] = [];
  let heads = 0;
  let changeDuringHead: (() => Promise<void>) | undefined;
  const completed = Promise.withResolvers<void>();
  try {
    await f.database.client`UPDATE factory.project_membership SET manage_project=true
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await f.database
      .client`INSERT INTO factory.project_repository_intent(command_id,setup_id,user_id,project_id,name,slug,kind,source_url,fingerprint,state)
      VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${f.userID},${f.projectID},'Owned import',${`native-${f.projectID}`},'import',
        'https://example.invalid/import.git',${"a".repeat(64)},'committed')`;
    const preparation = createProjectPreparation({
      database: f.database,
      head: async () => {
        heads++;
        await changeDuringHead?.();
        return "a".repeat(40);
      },
      start: async (id) => {
        admitted.push(id);
      },
    });
    const environments = createEnvironmentController(
      f.database,
      {
        configured: true,
        read: async (key) => stored.get(key),
        create: async (key, value) => {
          stored.set(key, value);
        },
      },
      "owned-development-preparation",
    );
    const service = createEnvironmentService(environments, (projectID, decision) => {
      const work = preparation.ensure(projectID, decision);
      work.then(completed.resolve, completed.reject);
      return work;
    });
    const commandID = crypto.randomUUID();
    const result = await service.save(f.projectID, f.userID, "development", {
      commandID,
      version: 0,
      variables: [],
      registries: [],
    });
    await completed.promise;
    const decision = {
      userID: f.userID,
      environment: "development" as const,
      commandID,
      version: result.version,
    };
    await preparation.ensure(f.projectID, decision);
    const jobs = await f.database.client`SELECT environment,environment_version::int AS version
      FROM factory.project_image_preparation WHERE project_id=${f.projectID}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({ environment: "development", version: 1 });
    expect(heads).toBe(2);
    // Saving a Project environment does not confirm App/QA setup or start
    // inference, Preview, native compute, or an external publication.
    expect(
      await f.database.client`SELECT inspection_id FROM factory.project_setup_confirmation`,
    ).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    expect(admitted).toEqual([]);
    for (const invalid of [
      { ...decision, commandID: crypto.randomUUID() },
      { ...decision, version: 0 },
      { ...decision, version: 2 },
      { ...decision, userID: crypto.randomUUID() },
      { ...decision, environment: "main-preview" as const },
    ])
      await expect(preparation.ensure(f.projectID, invalid)).rejects.toThrow();
    await f.database.client`UPDATE factory.project_membership SET manage_project=false
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await expect(preparation.ensure(f.projectID, decision)).rejects.toThrow(
      "Project Manager access required",
    );
    await f.database.client`UPDATE factory.project_membership SET manage_project=true
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect(heads).toBe(2);
    await preparation.drain();
    expect(admitted).toHaveLength(1);
    const nextCommandID = crypto.randomUUID();
    const next = await environments.save(f.projectID, f.userID, "development", {
      commandID: nextCommandID,
      version: 1,
      variables: [],
      registries: [],
    });
    changeDuringHead = async () => {
      await environments.save(f.projectID, f.userID, "development", {
        commandID: crypto.randomUUID(),
        version: next.version,
        variables: [],
        registries: [],
      });
    };
    await expect(
      preparation.ensure(f.projectID, {
        ...decision,
        commandID: nextCommandID,
        version: next.version,
      }),
    ).rejects.toThrow("Current committed environment save");
    expect(heads).toBe(3);
    const retained = await f.database.client`SELECT environment_version::int AS version
      FROM factory.project_image_preparation WHERE project_id=${f.projectID}`;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toEqual({ version: 1 });
    expect(admitted).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 60_000);

for (const producerEnvironment of ["development", "main-preview"] as const)
  test.each(["runtime-only", "build-variable", "registry"] as const)(
    `native image lookup isolates changed %s inputs from ${producerEnvironment}`,
    async (inputs) => {
      const f = await nativeRuntimeFixture();
      const preparationID = crypto.randomUUID();
      const producerID = runtimeIdentity(preparationID, 1).attemptID;
      const image = {
        identity: "9".repeat(64),
        image: `registry.test/open-factory/prebuilds/${f.projectID}@sha256:${"8".repeat(64)}`,
      };
      const manifest = {
        variables: [
          {
            name: "APP_TOKEN",
            runtime: true,
            build: inputs === "build-variable",
            verification: false,
          },
        ],
        registries: [
          {
            host: "registry.test",
            username: "owned-publisher",
            hasPassword: true,
            publish: true,
            verification: false,
          },
          ...(inputs === "registry" ? [{ host: "registry.private", verification: false }] : []),
        ],
      };
      const environment = async (name: "development" | "main-preview", version: number) => {
        const key = `owned-native-image-${crypto.randomUUID()}`;
        await f.database.client.begin(async (sql) => {
          await sql`INSERT INTO factory.environment_write(command_id,project_id,environment,base_version,fingerprint,manifest,secret_key,state,created_by,committed_at)
            VALUES(${crypto.randomUUID()},${f.projectID},${name},${version - 1},${"f".repeat(64)},${JSON.stringify(manifest)}::text::jsonb,${key},'committed',${f.userID},now())`;
          await sql`INSERT INTO factory.project_environment(project_id,environment,version,manifest,secret_key)
            VALUES(${f.projectID},${name},${version},${JSON.stringify(manifest)}::text::jsonb,${key})
            ON CONFLICT(project_id,environment) DO UPDATE SET version=excluded.version,manifest=excluded.manifest,secret_key=excluded.secret_key`;
        });
      };
      try {
        await environment(producerEnvironment, 1);
        const runtime = f.controller({
          ...f.configuration,
          prebuildRegistry: "registry.test",
          egressHosts: ["registry.test"],
        });
        await f.database
          .client`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version)
          VALUES(${preparationID},${f.projectID},${producerEnvironment},${f.revision},1)`;
        await runtime.startProjectPrebuild(preparationID);
        // Controlled publication metadata for cache lookup, not a live registry receipt.
        // Native publication authentication and cleanup have their own integration proof.
        await f.database.client`UPDATE factory.project_image_preparation
          SET state='succeeded',identity=${image.identity},image=${image.image} WHERE id=${preparationID}`;
        const preparation = createProjectPreparation({
          database: f.database,
          head: async () => f.revision,
          start: async () => {},
        });
        const request = (attemptID: string, token = f.connectorTokens(attemptID).parent) =>
          new Request(`https://factory.test/internal/project-image/${attemptID}`, {
            headers: { authorization: `Bearer ${token}`, "x-factory-runtime-generation": "1" },
          });
        const exact = await preparation.endpoint(request(producerID), producerID);
        expect(exact.status).toBe(200);
        expect(await exact.json()).toEqual(image);
        // Native publication always has a private registry grant. A newer
        // version, even runtime-only, or another environment cannot reuse it.
        await environment("development", producerEnvironment === "development" ? 2 : 1);
        const consumer = await runtime.start(f.projectID, f.userID);
        if (!consumer) throw Error("Owned image consumer was not admitted");
        expect(
          (await preparation.endpoint(request(consumer.id, "wrong"), consumer.id)).status,
        ).toBe(401);
        const response = await preparation.endpoint(request(consumer.id), consumer.id);
        expect(response.status).toBe(200);
        expect(await response.json()).toBeNull();
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${consumer.id}`;
        expect((await preparation.endpoint(request(consumer.id), consumer.id)).status).toBe(401);
      } finally {
        await f.dispose();
      }
    },
    60_000,
  );

test("public image classification excludes build variables, private registries and unknown metadata", async () => {
  const f = await substrateFixture();
  try {
    for (const [kind, build, registries, expected] of [
      ["runtime-only", false, [], true],
      ["build-variable", true, [], false],
      ["registry", false, [{ host: "registry.private" }], false],
    ] as const) {
      const secret = `owned-classification-${kind}`;
      await f.database
        .client`INSERT INTO factory.environment_write(command_id,project_id,environment,base_version,fingerprint,manifest,secret_key,state,created_by,committed_at)
        VALUES(${crypto.randomUUID()},${f.projectID},'development',0,${"f".repeat(64)},
          ${JSON.stringify({ variables: [{ name: "APP_TOKEN", runtime: true, build }], registries })}::text::jsonb,
          ${secret},'committed',${f.userID},now())`;
      expect(
        (await f.database.client`SELECT factory.image_build_is_public(${secret}) AS public`)[0]?.[
          "public"
        ],
      ).toBe(expected);
    }
    expect(
      (
        await f.database.client`SELECT factory.image_build_is_public(NULL) AS empty,
      factory.image_build_is_public('unknown-secret-metadata') AS unknown`
      )[0],
    ).toEqual({ empty: true, unknown: false });
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native image preparation coalesces exact jobs and admits one saved producer without consuming an application connection", async () => {
  const f = await substrateFixture();
  let head = "a".repeat(40);
  const started: string[] = [];
  try {
    const preparation = createProjectPreparation({
      database: f.database,
      head: async () => head,
      start: async (id) => {
        started.push(id);
        await f.database
          .client`UPDATE factory.project_image_preparation SET state='running' WHERE id=${id}`;
      },
    });
    await preparation.ensure(f.projectID);
    await preparation.ensure(f.projectID);
    expect(await f.database.client`SELECT id FROM factory.project_image_preparation`).toHaveLength(
      2,
    );
    head = "b".repeat(40);
    await preparation.ensure(f.projectID);
    await Promise.all([preparation.drain(), preparation.drain()]);
    expect(started).toHaveLength(1);
    expect(
      (
        await f.database
          .client`SELECT revision FROM factory.project_image_preparation WHERE id=${started[0] ?? null}`
      )[0]?.["revision"],
    ).toBe(head);
    await preparation.drain();
    expect(started).toHaveLength(1);
    expect(await f.database.client`SELECT 1 AS available`).toHaveLength(1);
    expect(
      (
        await f.database
          .client`SELECT count(*)::int AS count FROM factory.project_image_preparation WHERE state='unsupported'`
      )[0]?.["count"],
    ).toBe(2);
    const version = "9007199254740993";
    await f.database.client`INSERT INTO factory.project_environment(project_id,environment,version)
      VALUES(${f.projectID},'development',${version}::bigint)`;
    await preparation.ensure(f.projectID);
    const identity = createHash("sha256")
      .update(`${f.projectID}:development:${head}:${version}`)
      .digest("hex");
    const expectedID = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
    const [recipe] = await f.database.client`SELECT id,environment_version::text AS version
      FROM factory.project_image_preparation WHERE id=${expectedID}`;
    expect(recipe).toEqual({ id: expectedID, version });
    await preparation.ensure(f.projectID);
    expect(
      await f.database
        .client`SELECT id FROM factory.project_image_preparation WHERE id=${expectedID}`,
    ).toHaveLength(1);
    expect(started).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 60_000);
