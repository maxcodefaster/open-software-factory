import { expect, test } from "bun:test";
import { createProjectPreparation } from "../../apps/factory/src/runtime/project-preparation";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";
import { substrateFixture } from "../fixtures/substrate";

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
          .client`UPDATE factory.runtime_attempt SET stop_intended_at=now() WHERE id=${consumer.id}`;
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
  } finally {
    await f.dispose();
  }
}, 60_000);
