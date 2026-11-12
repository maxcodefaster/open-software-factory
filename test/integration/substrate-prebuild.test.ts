import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createProjectPreparation } from "../../apps/factory/src/runtime/project-preparation";
import { createSubstratePrebuild } from "../../apps/factory/src/runtime/substrate-prebuild";
import { substratePrebuildSourceIn } from "../../apps/factory/src/runtime/substrate-prebuild-grant";
import type { SubstrateWorkspaceConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

async function publicationEnvironment(
  f: Awaited<ReturnType<typeof substrateFixture>>,
  environment: "development" | "main-preview",
) {
  const secretKey = `owned-native-prebuild-${crypto.randomUUID()}`;
  const manifest = {
    variables: [],
    registries: [
      {
        host: "registry.test",
        username: "owned-publisher",
        verification: false,
        hasPassword: true,
        hasCertificate: false,
      },
    ],
  };
  await f.database.client.begin(async (sql) => {
    await sql`INSERT INTO factory.environment_write(command_id,project_id,environment,base_version,fingerprint,manifest,secret_key,state,created_by,committed_at)
      VALUES(${crypto.randomUUID()},${f.projectID},${environment},0,${"f".repeat(64)},${JSON.stringify(manifest)}::text::jsonb,${secretKey},'committed',${f.userID},now())`;
    await sql`INSERT INTO factory.project_environment(project_id,environment,version,manifest,secret_key)
      VALUES(${f.projectID},${environment},1,${JSON.stringify(manifest)}::text::jsonb,${secretKey})`;
  });
}

test("native prebuild retains exact inputs, lost-create outcomes, scoped grants, publication and UID-confirmed cleanup without a Workspace or legacy capacity", async () => {
  const f = await substrateFixture();
  const directory = await mkdtemp(join(tmpdir(), "native-prebuild-"));
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test-ca\n-----END CERTIFICATE-----\n");
  let preparationID = crypto.randomUUID();
  let attemptID = runtimeIdentity(preparationID, 1).attemptID;
  let atespace = `fa-${attemptID.replaceAll("-", "")}`;
  const secret = "owned-native-prebuild-secret";
  const objects = new Map<string, Record<string, unknown>>();
  const creates = new Map<string, number>();
  let actor: ReturnType<typeof nativeActor.parse> | undefined;
  let lose = "CreateAtespace";
  let resumes = 0;
  let deletes = 0;
  let lostDelete = true;
  let admissionChecks = 0;
  let admissionBlocked = true;
  const metadata = (name: string, space?: string) => ({
    name,
    uid: crypto.randomUUID(),
    version: "1",
    createTime: new Date().toISOString(),
    ...(space ? { atespace: space } : {}),
  });
  const call: SubstrateCall = async (method, request) => {
    const body = request as Record<string, unknown>;
    if (method.startsWith("Get")) {
      const kind = method.slice(3);
      if (kind === "Actor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (!objects.has(kind)) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(objects.get(kind));
    }
    if (method.startsWith("Create")) {
      const kind = method.slice(6);
      const [intent] = await f.database
        .client`SELECT runtime_attempt_id FROM factory.substrate_prebuild
        WHERE preparation_id=${preparationID}`;
      expect(intent?.["runtime_attempt_id"]).toBe(attemptID);
      const [fact] = await f.database.client<{ dispatched: boolean }[]>`
        SELECT CASE ${kind} WHEN 'Atespace' THEN atespace_attempted_at IS NOT NULL
          WHEN 'AtespaceAccessPolicy' THEN policy_attempted_at IS NOT NULL
          WHEN 'ActorTemplate' THEN template_attempted_at IS NOT NULL
          ELSE EXISTS(SELECT 1 FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID} AND create_attempted_at IS NOT NULL)
        END AS dispatched FROM factory.substrate_prebuild WHERE preparation_id=${preparationID}`;
      expect(fact?.dispatched).toBe(true);
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      let value: Record<string, unknown>;
      if (kind === "Atespace") value = { metadata: metadata(atespace) };
      else if (kind === "AtespaceAccessPolicy")
        value = { ...(body["accessPolicy"] as object), metadata: metadata("default") };
      else if (kind === "ActorTemplate")
        value = { ...(body["actorTemplate"] as object), metadata: metadata("runtime", atespace) };
      else if (kind === "ActorEgressPolicy")
        value = { ...(body["egressPolicy"] as object), metadata: metadata("default", atespace) };
      else if (kind === "Actor") {
        actor = nativeActor.parse({
          ...(body["actor"] as object),
          metadata: metadata(`runtime-${attemptID.replaceAll("-", "")}`, atespace),
          status: { state: "ACTOR_STATE_SUSPENDED" },
        });
        value = actor;
      } else throw new Error(`Unexpected ${method}`);
      objects.set(kind, value);
      if (method === lose) {
        lose = "";
        throw new SubstrateRPCError("Unavailable", "owned lost native reply");
      }
      return structuredClone(value);
    }
    if (method === "ResumeActor" && actor) {
      resumes++;
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor };
    }
    if (method === "DeleteActor" && actor) {
      expect(body["options"]).toEqual({ uid: actor.metadata.uid, version: actor.metadata.version });
      deletes++;
      actor = undefined;
      if (lostDelete) {
        lostDelete = false;
        throw new SubstrateRPCError("Unavailable", "owned lost Delete reply");
      }
      return {};
    }
    throw new Error(`Unexpected ${method}`);
  };
  const owner: SubstrateCall = async (method, request) => {
    expect([
      "GetAtespace",
      "CreateAtespace",
      "GetAtespaceAccessPolicy",
      "CreateAtespaceAccessPolicy",
    ]).toContain(method);
    return call(method, request);
  };
  const editor: SubstrateCall = async (method, request) => {
    expect(["CreateAtespace", "CreateAtespaceAccessPolicy"]).not.toContain(method);
    return call(method, request);
  };
  const configuration: SubstrateWorkspaceConfiguration = {
    deployment: "fresh-workspaces",
    database: f.config.database,
    projectID: f.projectID,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/unused/owner" },
    editorPrincipal: "user:system:serviceaccount:factory:owned-editor",
    connectorURL: f.config.connectorURL,
    factoryCAFile: ca,
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    prebuildRegistry: "registry.test",
    resources: { cpuMilli: 2000, memoryMiB: 4096 },
    profile: f.config.profile,
    runtime: f.config.runtime,
    workerSelector: {
      "factory.runtime/profile": f.config.profile,
      "factory.dev/deployment": "owned-prebuild",
    },
    egressHosts: ["registry.test"],
  };
  const controller = (selected: SubstrateWorkspaceConfiguration, provisioner = owner) =>
    createRuntimeController(
      f.database,
      f.hub,
      secret,
      {
        async prepareExecution() {
          throw new Error("Native prebuild cannot prepare legacy Source");
        },
      },
      {
        async apply() {
          throw new Error("Native prebuild cannot create legacy resources");
        },
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      editor,
      selected,
      provisioner,
      {
        async requireReady() {
          admissionChecks++;
          if (admissionBlocked) throw new Error("owned native capacity occupied");
        },
      } as never,
    );
  let runtime = controller(configuration);
  const preparation = createProjectPreparation({
    database: f.database,
    head: async () => "a".repeat(40),
    start: (id) => runtime.startProjectPrebuild(id),
    finish: (id) => runtime.status(id, "stopped"),
  });
  const source = () => f.database.client.begin((sql) => substratePrebuildSourceIn(sql, attemptID));
  try {
    await publicationEnvironment(f, "main-preview");
    await f.database
      .client`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version)
      VALUES(${preparationID},${f.projectID},'main-preview',${"a".repeat(40)},1)`;
    const workspaces = await f.database.client`SELECT * FROM factory.development_workspace`;
    const withoutRegistry = { ...configuration };
    delete withoutRegistry.prebuildRegistry;
    await expect(controller(withoutRegistry).startProjectPrebuild(preparationID)).rejects.toThrow(
      "admitted TLS registry",
    );
    expect(creates.size).toBe(0);
    await expect(runtime.startProjectPrebuild(preparationID)).rejects.toThrow(
      "owned native capacity occupied",
    );
    expect(await f.database.client`SELECT * FROM factory.substrate_prebuild`).toHaveLength(0);
    expect(creates.size).toBe(0);
    admissionBlocked = false;
    for (const stage of [
      "CreateAtespace",
      "CreateAtespaceAccessPolicy",
      "CreateActorTemplate",
      "CreateActor",
    ]) {
      lose = stage;
      await expect(runtime.startProjectPrebuild(preparationID)).rejects.toThrow(
        "owned lost native reply",
      );
    }
    await runtime.startProjectPrebuild(preparationID);
    expect(resumes).toBe(1);
    expect(admissionChecks).toBe(2);
    for (const kind of ["Atespace", "AtespaceAccessPolicy", "ActorTemplate", "Actor"])
      expect(creates.get(kind)).toBe(1);
    const [attempt] = await f.database
      .client`SELECT id,state,workspace_id,change_id,isolated_kind,substrate,factorybox_worker_id,factorybox_admission_id
      FROM factory.runtime_attempt WHERE id=${attemptID}`;
    expect(attempt).toEqual({
      id: attemptID,
      state: "starting",
      workspace_id: null,
      change_id: null,
      isolated_kind: "prebuild",
      substrate: true,
      factorybox_worker_id: null,
      factorybox_admission_id: null,
    });
    expect(await source()).toBe("https://example.invalid/fixture.git");
    await f.database
      .client`UPDATE factory.project SET repository_url='https://example.invalid/other.git' WHERE id=${f.projectID}`;
    await expect(source()).rejects.toThrow("prebuild Source grant required");
    await f.database
      .client`UPDATE factory.project SET repository_url='https://example.invalid/fixture.git' WHERE id=${f.projectID}`;
    const [environment] = await f.database
      .client`SELECT environment,version::int AS version FROM factory.runtime_environment_intent WHERE runtime_attempt_id=${attemptID}`;
    expect(environment).toEqual({ environment: "main-preview", version: 1 });
    const template = objects.get("ActorTemplate") as { containers: { env: { value: string }[] }[] };
    const bootstrap = JSON.parse(template.containers[0]?.env[0]?.value ?? "null");
    expect(bootstrap.assignment.prebuild).toEqual({
      id: preparationID,
      platform: "linux/amd64",
      imageRepository: `registry.test/open-factory/prebuilds/${f.projectID}`,
    });
    expect(bootstrap.assignment.channels).toEqual([
      { name: "ide", kind: "ide", target: "", healthPath: "" },
    ]);
    expect(bootstrap.assignment.processes).toEqual([]);
    expect(bootstrap.sourceHandoff).toBe(false);
    // Validate the actual generated bootstrap with the shipped pre-Docker
    // entrypoint. Source handoff is false, so this validates/returns without
    // reading Source, starting Docker or requiring native control credentials.
    const connector = join(directory, "connector");
    const build = Bun.spawn(
      ["go", "build", "-trimpath", "-o", connector, "./cmd/factory-runtime-connector"],
      {
        cwd: "services/runtime-connector",
        env: {
          PATH: process.env["PATH"],
          HOME: process.env["HOME"],
          TMPDIR: process.env["TMPDIR"],
          CGO_ENABLED: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const buildOutput = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(await build.exited, buildOutput.join("\n")).toBe(0);
    const validate = async (value: unknown) => {
      const process = Bun.spawn([connector, "native-source-restore"], {
        env: { FACTORY_SUBSTRATE_BOOTSTRAP: JSON.stringify(value) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      return { status: await process.exited, output: output.join("\n") };
    };
    const validated = await validate(bootstrap);
    expect(validated.status, validated.output).toBe(0);
    const invalid = await validate({
      ...bootstrap,
      assignment: { ...bootstrap.assignment, channels: [] },
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.output).toContain("invalid Source cold bootstrap");
    const [provision] = await f.database
      .client`SELECT intent,template FROM factory.substrate_prebuild WHERE preparation_id=${preparationID}`;
    expect(JSON.stringify(provision)).not.toContain("parentToken");
    expect(JSON.stringify(provision)).not.toContain("childToken");
    let ownerCalls = 0;
    runtime = controller(
      {
        ...configuration,
        prebuildRegistry: "next-registry.test",
        workloadImage: `registry.test/native@sha256:${"b".repeat(64)}`,
        resources: { cpuMilli: 3000, memoryMiB: 6144 },
      },
      async () => {
        ownerCalls++;
        throw new SubstrateRPCError("Unauthenticated", "expired owner");
      },
    );
    await runtime.startProjectPrebuild(preparationID);
    expect(ownerCalls).toBe(0);
    expect(resumes).toBe(1);
    const policy = objects.get("AtespaceAccessPolicy");
    if (!policy) throw new Error("Missing owned policy");
    objects.set("AtespaceAccessPolicy", { ...policy, bindings: [] });
    await expect(runtime.startProjectPrebuild(preparationID)).rejects.toThrow("grant differs");
    objects.set("AtespaceAccessPolicy", policy);
    const token = runtimeConnectorTokens(secret, attemptID, 1).parent;
    const upload = (image: string, identity = "c".repeat(64), generation = "1") =>
      preparation.endpoint(
        new Request(`https://factory.test/internal/project-image/${attemptID}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-factory-runtime-generation": generation,
            "content-type": "application/json",
          },
          body: JSON.stringify({ identity, image }),
        }),
        attemptID,
      );
    expect(
      (await upload(`registry.test/foreign/${f.projectID}@sha256:${"d".repeat(64)}`)).status,
    ).toBe(401);
    const image = `registry.test/open-factory/prebuilds/${f.projectID}@sha256:${"d".repeat(64)}`;
    expect((await upload(image, "c".repeat(64), "2")).status).toBe(401);
    await f.database
      .client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${f.userID}`;
    expect((await upload(image)).status).toBe(401);
    await expect(source()).rejects.toThrow("Account access is disabled");
    await f.database
      .client`UPDATE factory.account_access SET disabled_at=NULL WHERE user_id=${f.userID}`;
    expect((await upload(image)).status).toBe(204);
    expect((await upload(image)).status).toBe(204);
    expect((await upload(image, "e".repeat(64))).status).toBe(409);
    await expect(source()).rejects.toThrow("prebuild authority");
    await expect(runtime.status(attemptID, "stopped")).rejects.toThrow("owned lost Delete reply");
    expect(deletes).toBe(1);
    expect(
      (
        await f.database
          .client`SELECT deleted_at FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID}`
      )[0]?.["deleted_at"],
    ).toBeNull();
    await preparation.drain();
    expect((await runtime.get(attemptID))?.state).toBe("stopped");
    expect(deletes).toBe(1);
    expect(
      (
        await f.database
          .client`SELECT deleted_at FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID}`
      )[0]?.["deleted_at"],
    ).not.toBeNull();
    expect(
      (
        await f.database
          .client`SELECT state,image FROM factory.project_image_preparation WHERE id=${preparationID}`
      )[0],
    ).toEqual({ state: "succeeded", image });
    expect(await f.database.client`SELECT * FROM factory.development_workspace`).toEqual(
      workspaces,
    );
    for (const table of [
      "workspace_source",
      "substrate_source",
      "factorybox_worker",
      "runtime_artifact_intent",
    ])
      expect(await f.database.client.unsafe(`SELECT * FROM factory.${table}`)).toHaveLength(0);
    await expect(
      Promise.resolve(
        f.database
          .client`DELETE FROM factory.substrate_prebuild WHERE preparation_id=${preparationID}`,
      ),
    ).rejects.toThrow("cannot be reused");
    const predecessorID = attemptID;
    const predecessor = [
      ...(await f.database
        .client`SELECT * FROM factory.substrate_prebuild WHERE runtime_attempt_id=${predecessorID}`),
    ];
    await publicationEnvironment(f, "development");
    preparationID = crypto.randomUUID();
    attemptID = runtimeIdentity(preparationID, 1).attemptID;
    atespace = `fa-${attemptID.replaceAll("-", "")}`;
    objects.clear();
    runtime = controller(configuration);
    await f.database
      .client`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version)
      VALUES(${preparationID},${f.projectID},'development',${"a".repeat(40)},1)`;
    await runtime.startProjectPrebuild(preparationID);
    expect(creates.get("Actor")).toBe(2);
    expect(resumes).toBe(2);
    expect([
      ...(await f.database
        .client`SELECT generation::int AS generation FROM factory.runtime_attempt WHERE project_id=${f.projectID} AND isolated_kind='prebuild' ORDER BY id`),
    ]).toEqual([{ generation: 1 }, { generation: 1 }]);
    expect([
      ...(await f.database
        .client`SELECT * FROM factory.substrate_prebuild WHERE runtime_attempt_id=${predecessorID}`),
    ]).toEqual(predecessor);
    expect((await runtime.get(predecessorID))?.state).toBe("stopped");
    expect((await runtime.stop(attemptID))?.state).toBe("stopped");
  } finally {
    f.hub.revoke(attemptID);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

for (const outcome of ["rejected", "unknown", "missing-publication-grant"] as const)
  test(`native prebuild retains an ${outcome} provisioning dispatch instead of creating again or adopting a successor`, async () => {
    const f = await substrateFixture();
    const directory = await mkdtemp(join(tmpdir(), "native-prebuild-refusal-"));
    const ca = join(directory, "ca.pem");
    await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test-ca\n-----END CERTIFICATE-----\n");
    const preparationID = crypto.randomUUID();
    let creates = 0;
    const call: SubstrateCall = async (method) => {
      if (method === "GetAtespace") throw new SubstrateRPCError("NotFound", "absent original");
      if (method === "CreateAtespace") {
        creates++;
        throw new SubstrateRPCError(
          outcome === "rejected" ? "PermissionDenied" : "Unavailable",
          "owned unsettled create",
        );
      }
      throw new Error(`Unexpected native dispatch: ${method}`);
    };
    const native = createSubstratePrebuild(
      f.database,
      f.hub,
      "owned-prebuild-refusal",
      {
        deployment: "fresh-workspaces",
        database: f.config.database,
        projectID: f.projectID,
        connection: f.config.connection,
        provisioner: f.config.connection,
        editorPrincipal: "user:system:serviceaccount:factory:owned-editor",
        connectorURL: f.config.connectorURL,
        factoryCAFile: ca,
        workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
        prebuildRegistry: "registry.test",
        profile: f.config.profile,
        runtime: f.config.runtime,
        workerSelector: {
          "factory.runtime/profile": f.config.profile,
          "factory.dev/deployment": "owned-prebuild-refusal",
        },
        egressHosts: ["registry.test"],
      },
      call,
      call,
    );
    try {
      if (outcome !== "missing-publication-grant") await publicationEnvironment(f, "development");
      await f.database
        .client`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version)
        VALUES(${preparationID},${f.projectID},'development',${"a".repeat(40)},${outcome === "missing-publication-grant" ? 0 : 1})`;
      if (outcome === "missing-publication-grant") {
        await expect(native.start(preparationID)).rejects.toThrow(
          "Project Environment registry publication grant",
        );
        expect(creates).toBe(0);
        expect(await f.database.client`SELECT * FROM factory.substrate_prebuild`).toHaveLength(0);
        expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
        return;
      }
      await expect(native.start(preparationID)).rejects.toThrow("owned unsettled create");
      await expect(native.start(preparationID)).rejects.toThrow(
        outcome === "rejected" ? "Create was rejected" : "absent original",
      );
      expect(creates).toBe(1);
      const [row] = await f.database
        .client`SELECT atespace_attempted_at,atespace_rejected,atespace FROM factory.substrate_prebuild WHERE preparation_id=${preparationID}`;
      expect(row?.["atespace_attempted_at"]).not.toBeNull();
      expect(row?.["atespace_rejected"]).toBe(outcome === "rejected");
      expect(row?.["atespace"]).toBeNull();
      expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
      await expect(
        Promise.resolve(
          f.database
            .client`UPDATE factory.substrate_prebuild SET atespace_attempted_at=NULL WHERE preparation_id=${preparationID}`,
        ),
      ).rejects.toThrow("immutable");
    } finally {
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
