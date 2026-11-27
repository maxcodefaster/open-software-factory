import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { EnvironmentBundle } from "#project-domain/environment";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
  runtimeIdentity,
  runtimeProjectEntryToken,
} from "#runtime-domain/identity";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type {
  EnvironmentSecrets,
  StoredEnvironment,
} from "../../apps/factory/src/environments/openbao";
import {
  createRuntimeEnvironmentEndpoint,
  freezeRuntimeEnvironment,
} from "../../apps/factory/src/environments/runtime";
import { nativeProjectTemplate } from "../fixtures/native-project";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { substrateFixture } from "../fixtures/substrate";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";

const secret = "owned-native-project-entry-secret";
const inheritedPostgres = process.env["FACTORY_TEST_POSTGRES"];
let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
beforeAll(async () => {
  if (!inheritedPostgres) {
    postgres = await ownedPostgresServer();
    process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
  }
}, 60_000);
afterAll(async () => {
  if (inheritedPostgres === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
  else process.env["FACTORY_TEST_POSTGRES"] = inheritedPostgres;
  await postgres?.dispose();
});

async function entryFixture(
  options: {
    kind?: "personal" | "ticket";
    source?: "actor" | "service" | "none";
    generation?: number;
    provision?: boolean;
    projectTemplate?: unknown;
    variables?: EnvironmentBundle["variables"];
    sourceConnected?: boolean;
  } = {},
) {
  const f = await substrateFixture("a".repeat(40), options.kind);
  try {
    const stored = new Map<string, StoredEnvironment>();
    let reads = 0;
    const secrets: EnvironmentSecrets = {
      configured: true,
      async read(key) {
        reads++;
        return stored.get(key);
      },
      async create(key, value) {
        stored.set(key, value);
      },
    };
    await f.database.client`UPDATE factory.project_membership SET manage_project=true
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    const environments = createEnvironmentController(f.database, secrets, secret);
    const variables = [
      { name: "RUNTIME", runtime: true, verification: false },
      { name: "UNUSED", runtime: false, verification: false },
      { name: "VERIFIED_RUNTIME", runtime: true, verification: true },
      { name: "VERIFICATION_ONLY", runtime: false, verification: true },
    ]
      .map((variable) => ({ ...variable, value: `owned-${variable.name}-value` }))
      .concat(options.variables ?? []);
    await environments.save(f.projectID, f.userID, "development", {
      commandID: crypto.randomUUID(),
      version: 0,
      variables,
    });
    reads = 0;
    const generation = options.generation ?? 1;
    const attemptID = runtimeIdentity(f.workspaceID, generation).attemptID;
    const actorUID = crypto.randomUUID();
    const tokens = runtimeConnectorTokens(secret, attemptID, generation);
    // Controlled persisted ownership only: no controller or native Create runs.
    await f.database.client.begin(async (sql) => {
      if (options.source === "service") {
        const seedID = crypto.randomUUID();
        const seed = {
          version: 1,
          id: seedID,
          workspaceID: f.workspaceID,
          projectID: f.projectID,
          repositoryURL: "https://example.invalid/fixture.git",
          revision: "a".repeat(40),
          branch: f.branch,
        };
        await sql`INSERT INTO factory.substrate_source(workspace_id,owner,service_base,seed)
          VALUES(${f.workspaceID},'service',${seedID},${JSON.stringify(seed)}::jsonb)`;
      }
      if (options.provision !== false) {
        const projectTemplate =
          "projectTemplate" in options ? options.projectTemplate : nativeProjectTemplate;
        await sql`INSERT INTO factory.substrate_provision(owner_id,kind,generation,intent)
          VALUES(${f.workspaceID},'workspace',1,${JSON.stringify({ projectTemplate })}::jsonb)`;
      }
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,
        revision,state,parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent,actor_uid,create_attempted_at)
        VALUES(${attemptID},${f.projectID},${f.workspaceID},${f.kind === "ticket" ? f.changeID : null},
          ${generation},${"a".repeat(40)},'create-intended',${hashConnectorToken(tokens.parent)},
          now(),${f.userID},
          ${`fa-${attemptID.replaceAll("-", "")}`},
          ${`runtime-${attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
      await freezeRuntimeEnvironment(sql, attemptID);
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${attemptID}`;
      if (f.kind === "ticket") {
        await sql`UPDATE factory.change SET runtime_attempt_id=${attemptID} WHERE id=${f.changeID}`;
        await sql`UPDATE factory.change_writer SET state='human',user_id=${f.userID},epoch=2
          WHERE change_id=${f.changeID}`;
      }
    });
    if ((options.source ?? "actor") === "actor") await f.admitActorSource(actorUID);
    let sourceConnected = options.sourceConnected ?? true;
    const transport = {
      sourceConnected: (requested: string) => requested === attemptID && sourceConnected,
      sourceEpoch: (requested: string): number | undefined =>
        requested === attemptID && sourceConnected ? 1 : undefined,
    };
    const endpoint = createRuntimeEnvironmentEndpoint(f.database, secrets, secret, transport);
    function request(overrides: Record<string, string | null> = {}, method = "GET") {
      const headers = new Headers({
        authorization: `Bearer ${runtimeProjectEntryToken(secret, attemptID, generation, "work")}`,
        "X-Factory-Runtime-Generation": String(generation),
        "X-Factory-Runtime-Actor-UID": actorUID,
        "X-Factory-Runtime-Container": "work",
      });
      for (const [name, value] of Object.entries(overrides))
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      return new Request(`https://factory.test/internal/runtime-environment/${attemptID}`, {
        method,
        headers,
      });
    }
    return {
      ...f,
      attemptID,
      actorUID,
      tokens,
      secrets,
      stored,
      variables,
      transport,
      setSourceConnected(connected: boolean) {
        sourceConnected = connected;
      },
      environments,
      endpoint,
      request,
      reads: () => reads,
      entry: (overrides?: Record<string, string | null>, method?: string) =>
        endpoint(request(overrides, method), attemptID),
    };
  } catch (cause) {
    await f.dispose();
    throw cause;
  }
}

async function isolatedEntryFixture(
  kind: "verification" | "staging" | "publication",
  projectTemplate: unknown = nativeProjectTemplate,
) {
  const f = await entryFixture({ kind: "ticket", source: "none" });
  try {
    if (kind === "staging")
      await f.environments.save(f.projectID, f.userID, "main-preview", {
        commandID: crypto.randomUUID(),
        version: 0,
        variables: f.variables,
      });
    const ownerID =
      kind === "staging"
        ? runtimeIdentity(`staging:${f.projectID}`, 1).attemptID
        : crypto.randomUUID();
    const attemptID = runtimeIdentity(ownerID, 1).attemptID;
    const actorUID = crypto.randomUUID();
    const releaseID = crypto.randomUUID();
    const runnerUUID = crypto.randomUUID();
    const tokens = runtimeConnectorTokens(secret, attemptID, 1);
    // Synthetic confirmed native ownership in the owned database, preserving
    // every baseline trigger. No ActorTemplate/Actor or controller is created.
    await f.database.client.begin(async (sql) => {
      const envName = kind === "staging" ? "main-preview" : "development";
      const [scope] = await sql<{ database: string; version: number; secretKey: string | null }[]>`
        SELECT current_database() AS database,(payload->>'version')::float8 AS version,payload->>'secretKey' AS "secretKey"
        FROM factory.operation WHERE kind='environments.environment' AND scope_type='project'
          AND scope_id=${f.projectID}
          AND idempotency_key=${`environments.environment:${f.projectID}:${envName}`}`;
      if (!scope) throw new Error("Owned isolated environment is missing");
      const environment = {
        environment: kind === "staging" ? "main-preview" : "development",
        version: kind === "publication" ? 0 : scope.version,
        secretKey: kind === "publication" ? null : scope.secretKey,
      };
      if (kind === "verification")
        await sql`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,
          action_run_id,runner_uuid,runner_token,runner_job_handle,created_by)
          VALUES(${ownerID},${f.changeID},${"a".repeat(40)},1,1,
            ${runnerUUID},'owned-runner-token','owned-entry-job',${f.userID})`;
      else if (kind === "staging")
        await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
          VALUES(${crypto.randomUUID()},'delivery.staging_preview','project',${f.projectID},
            ${`delivery.staging_preview:${f.projectID}`},'pending',
            ${JSON.stringify({ projectId: f.projectID, revision: "a".repeat(40), runtimeAttemptId: null })}::jsonb)`;
      else {
        const attemptCommandID = crypto.randomUUID();
        await sql`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,notes,state,created_by)
          VALUES(${releaseID},${f.projectID},${crypto.randomUUID()},'1.0.0',${"a".repeat(40)},'Owned publication','running',${f.userID})`;
        await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
          VALUES(${ownerID},'releases.attempt','project_release',${releaseID},${`releases.attempt:${attemptCommandID}`},
            ${`releases.attempt.ordinal:${releaseID}:1`},'running',
            ${JSON.stringify({
              id: ownerID,
              releaseId: releaseID,
              commandId: attemptCommandID,
              ordinal: 1,
              dispatchIntendedAt: new Date().toISOString(),
              runId: 1,
              runnerId: null,
              runnerUuid: runnerUUID,
              runnerToken: "owned-runner-token",
              jobHandle: "owned-entry-job",
              runtimeAttemptId: null,
              cleanedAt: null,
            })}::jsonb,${f.userID})`;
      }
      const atespace = { metadata: { uid: crypto.randomUUID() } };
      const template = { metadata: { uid: crypto.randomUUID(), version: "1" } };
      const intent = {
        configuration: {
          projectID: f.projectID,
          database: scope.database,
        },
        revision: "a".repeat(40),
        repository: "https://example.invalid/fixture.git",
        actorTemplatePath: nativeProjectTemplate.path,
        projectTemplate,
        templateSHA256: "d".repeat(64),
        createdBy: f.userID,
        environment,
        promotionID: null,
        declaration: kind === "staging" ? {} : null,
        runnerUUID,
        jobHandle: kind === "publication" || kind === "verification" ? "owned-entry-job" : null,
        version: "1.0.0",
      };
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,project_id,runtime_attempt_id,generation,intent,resources)
        VALUES(${ownerID},${kind},${kind === "verification" ? null : f.projectID},${attemptID},1,${JSON.stringify(intent)}::text::jsonb,
          jsonb_build_object(
            'atespace',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify(atespace)}::text::jsonb),
            'policy',jsonb_build_object('attemptedAt',to_jsonb(now()),'value','{}'::jsonb),
            'template',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify(template)}::text::jsonb)))`;
      const binding = {
        projectID: f.projectID,
        generation: 1,
        verificationID: kind === "verification" ? ownerID : null,
        isolatedID: kind === "staging" || kind === "publication" ? ownerID : null,
        isolatedKind: kind,
        promotionID: null,
        atespaceUID: atespace.metadata.uid,
        templateUID: template.metadata.uid,
        templateVersion: "1",
        templateSHA256: intent.templateSHA256,
        environment,
      };
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,verification_id,generation,
        revision,state,parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent,actor_uid,create_attempted_at)
        VALUES(${attemptID},${f.projectID},${kind},${kind === "verification" ? ownerID : null},1,
          ${"a".repeat(40)},'create-intended',${hashConnectorToken(tokens.parent)},
          now(),${f.userID},
          ${`fa-${attemptID.replaceAll("-", "")}`},
          ${`runtime-${attemptID.replaceAll("-", "")}`},${JSON.stringify(binding)}::jsonb,${actorUID},now())`;
      await freezeRuntimeEnvironment(sql, attemptID);
      if (kind === "verification")
        await sql`UPDATE factory.verification SET runtime_attempt_id=${attemptID} WHERE id=${ownerID}`;
      else if (kind === "publication")
        await sql`UPDATE factory.operation
          SET payload=jsonb_set(payload,'{runtimeAttemptId}',to_jsonb(${attemptID}::text)), updated_at=now()
          WHERE id=${ownerID} AND kind='releases.attempt'`;
      else
        await sql`UPDATE factory.operation
          SET state='attached', payload=jsonb_set(payload,'{runtimeAttemptId}',to_jsonb(${attemptID}::text)), updated_at=now()
          WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}
            AND idempotency_key=${`delivery.staging_preview:${f.projectID}`}`;
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${attemptID}`;
    });
    let connected = true;
    const transport = {
      sourceConnected: (requested: string) => requested === attemptID && connected,
      sourceEpoch: (requested: string) => (requested === attemptID && connected ? 1 : undefined),
    };
    const endpoint = createRuntimeEnvironmentEndpoint(f.database, f.secrets, secret, transport);
    function request(overrides: Record<string, string | null> = {}) {
      const headers = new Headers({
        authorization: `Bearer ${runtimeProjectEntryToken(secret, attemptID, 1, "work")}`,
        "X-Factory-Runtime-Generation": "1",
        "X-Factory-Runtime-Actor-UID": actorUID,
        "X-Factory-Runtime-Container": "work",
      });
      for (const [name, value] of Object.entries(overrides))
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      return new Request(`https://factory.test/internal/runtime-environment/${attemptID}`, {
        headers,
      });
    }
    return {
      ...f,
      attemptID,
      actorUID,
      ownerID,
      tokens,
      transport,
      request,
      entry: (overrides?: Record<string, string | null>) => endpoint(request(overrides), attemptID),
      setSourceConnected(value: boolean) {
        connected = value;
      },
    };
  } catch (cause) {
    await f.dispose();
    throw cause;
  }
}

test("native entry authenticates the exact container, capability, immutable UID and generation without Parent fallback", async () => {
  const password = {
    name: "POSTGRES_PASSWORD",
    value: "owned-native-database-password",
    runtime: true,
    verification: true,
  };
  const f = await entryFixture({ variables: [password] });
  try {
    const work = await f.entry();
    expect(work.status).toBe(200);
    expect((await work.json()).bundle.variables).toContainEqual(password);
    const before = f.reads();
    for (const overrides of [
      { authorization: null },
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${f.tokens.parent}` },
      { authorization: `Bearer ${f.tokens.child}` },
      {
        authorization: `Bearer ${runtimeProjectEntryToken("other", f.attemptID, 1, "work")}`,
      },
      {
        authorization: `Bearer ${runtimeProjectEntryToken(secret, crypto.randomUUID(), 1, "work")}`,
      },
      { "X-Factory-Runtime-Container": null },
      { "X-Factory-Runtime-Container": "" },
      { "X-Factory-Runtime-Container": "Work" },
      { "X-Factory-Runtime-Container": "a".repeat(64) },
      { "X-Factory-Runtime-Container": "database" },
      ...[null, "0", "2", "01", "1.0", "1e0", "+1"].map((generation) => ({
        "X-Factory-Runtime-Generation": generation,
      })),
    ])
      expect((await f.entry(overrides)).status).toBe(401);
    for (const actorUID of [null, crypto.randomUUID(), f.actorUID.toUpperCase()])
      expect((await f.entry({ "X-Factory-Runtime-Actor-UID": actorUID })).status).toBe(403);
    expect((await f.entry({}, "POST")).status).toBe(401);
    expect(
      (
        await f.entry({
          "X-Factory-Runtime-Container": "not-admitted",
          authorization: `Bearer ${runtimeProjectEntryToken(secret, f.attemptID, 1, "not-admitted")}`,
        })
      ).status,
    ).toBe(403);
    expect(f.reads()).toBe(before);
    const database = await f.entry({
      "X-Factory-Runtime-Container": "database",
      authorization: `Bearer ${runtimeProjectEntryToken(secret, f.attemptID, 1, "database")}`,
    });
    expect(database.status).toBe(200);
    const environment = await database.json();
    expect(environment.bundle.variables).toContainEqual(password);
    expect(environment.bundle).not.toHaveProperty("registries");
  } finally {
    await f.dispose();
  }
}, 30_000);

test.each(["none", "service"] as const)(
  "authenticated native entry awaits %s Source with retryable 409, but revoked authority is not retryable",
  async (source) => {
    const f = await entryFixture({ source });
    try {
      const pending = await f.entry();
      expect(pending.status).toBe(409);
      expect(pending.headers.get("cache-control")).toBe("no-store");
      expect((await f.entry({ authorization: "Bearer wrong" })).status).toBe(401);
      expect(f.reads()).toBe(0);
      if (source === "none") {
        await f.admitActorSource(f.actorUID);
        expect((await f.entry()).status).toBe(200);
      }
      const reads = f.reads();
      await f.database.client`DELETE FROM factory.project_membership
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      expect((await f.entry()).status).toBe(403);
      expect(f.reads()).toBe(reads);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test("native entry waits for trusted Parent Source, including missing transport and disconnect during a secret read", async () => {
  const f = await entryFixture({ sourceConnected: false });
  try {
    const disconnected = await f.entry();
    expect(disconnected.status).toBe(409);
    expect(disconnected.headers.get("cache-control")).toBe("no-store");
    const withoutTransport = createRuntimeEnvironmentEndpoint(f.database, f.secrets, secret);
    expect((await withoutTransport(f.request(), f.attemptID)).status).toBe(409);
    expect(f.reads()).toBe(0);
    // The existing Parent operation does not depend on the new native gate.
    const legacy = createRuntimeEnvironmentEndpoint(f.database, f.secrets);
    expect(
      (
        await legacy(
          f.request({
            "X-Factory-Runtime-Container": null,
            authorization: `Bearer ${f.tokens.parent}`,
          }),
          f.attemptID,
        )
      ).status,
    ).toBe(200);
    f.setSourceConnected(true);
    expect((await f.entry()).status).toBe(200);
    const read = f.secrets.read;
    f.secrets.read = async (key) => {
      f.setSourceConnected(false);
      return read(key);
    };
    expect((await f.entry()).status).toBe(409);
    const reads = f.reads();
    await f.database.client`DELETE FROM factory.project_membership
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect((await f.entry()).status).toBe(403);
    expect(f.reads()).toBe(reads);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("native entry requires the exact restored Source epoch, including after a secrets read", async () => {
  const f = await entryFixture();
  try {
    const epoch = f.transport.sourceEpoch;
    f.transport.sourceEpoch = () => 0;
    expect((await f.entry()).status).toBe(409);
    expect(f.reads()).toBe(0);
    f.transport.sourceEpoch = epoch;
    const read = f.secrets.read;
    f.secrets.read = async (key) => {
      const bundle = await read(key);
      f.transport.sourceEpoch = () => 2;
      return bundle;
    };
    expect((await f.entry()).status).toBe(409);
    f.transport.sourceEpoch = epoch;
    f.secrets.read = read;
    expect((await f.entry()).status).toBe(200);
  } finally {
    await f.dispose();
  }
}, 30000);

test.each([
  "ATE_IDENTITY",
  "SSL_CERT_FILE",
  "ssl_cert_file",
  "GIT_SSL_CAINFO",
  "git_ssl_cainfo",
  "NODE_EXTRA_CA_CERTS",
  "node_extra_ca_certs",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
])(
  "native entry rejects runtime transport override %s",
  async (name) => {
    const f = await entryFixture({
      variables: [{ name, value: "never-admit", runtime: true, verification: true }],
    });

    try {
      const response = await f.entry();
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("never-admit");
      // Native restrictions must not change the existing Parent environment.
      const parent = await f.entry({
        "X-Factory-Runtime-Container": null,
        authorization: `Bearer ${f.tokens.parent}`,
      });
      expect(parent.status).toBe(200);
      expect((await parent.json()).bundle.variables.at(-1)).toMatchObject({
        name,
        value: "never-admit",
      });
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test("non-runtime transport names are never selected for native entry", async () => {
  const f = await entryFixture({
    variables: [
      {
        name: "HTTP_PROXY",
        value: "non-runtime-proxy",
        runtime: false,
        verification: true,
      },
      {
        name: "ATE_IDENTITY",
        value: "non-runtime-identity",
        runtime: false,
        verification: true,
      },
    ],
  });
  try {
    const response = await f.entry();
    expect(response.status).toBe(200);
    expect((await response.json()).bundle.variables).toEqual(
      f.variables.filter((variable) => variable.runtime),
    );
  } finally {
    await f.dispose();
  }
}, 30_000);

test("native entry and Parent return only frozen runtime variables in the same envelope", async () => {
  const f = await entryFixture();
  try {
    const response = await f.entry();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const expected = {
      version: 1,
      bundle: { variables: f.variables.filter((variable) => variable.runtime) },
    };
    expect(await response.json()).toEqual(expected);
    const parent = await f.entry({
      "X-Factory-Runtime-Container": null,
      authorization: `Bearer ${f.tokens.parent}`,
    });
    expect(parent.status).toBe(200);
    expect(await parent.json()).toEqual(expected);
    await f.database.client`UPDATE factory.project SET actor_template_path='.factory/replaced.json'
      WHERE id=${f.projectID}`;
    await f.environments.save(f.projectID, f.userID, "development", {
      commandID: crypto.randomUUID(),
      version: 1,
      variables: [
        {
          name: "NEW_RUNTIME",
          value: "not-admitted",
          runtime: true,
          verification: true,
        },
      ],
    });
    expect(await (await f.entry()).json()).toEqual(expected);
    const wire = JSON.stringify(expected);
    for (const value of [
      "VERIFICATION_ONLY",
      "UNUSED",
      "not-admitted",
      f.tokens.parent,
      f.tokens.child,
      secret,
    ])
      expect(wire).not.toContain(value);
  } finally {
    await f.dispose();
  }
}, 30_000);

test.each([
  ["missing provisioning", { provision: false }],
  ["missing frozen template", { projectTemplate: null }],
  [
    "metadata without raw bytes",
    { projectTemplate: { path: nativeProjectTemplate.path, sha256: nativeProjectTemplate.sha256 } },
  ],
  [
    "unconfirmed raw bytes",
    { projectTemplate: { ...nativeProjectTemplate, sha256: "0".repeat(64) } },
  ],
  [
    "malformed raw bytes",
    { projectTemplate: { content: "{", sha256: createHash("sha256").update("{").digest("hex") } },
  ],
  [
    "invalid Project template",
    { projectTemplate: { content: "{}", sha256: createHash("sha256").update("{}").digest("hex") } },
  ],
  ["another Workspace generation", { generation: 2 }],
] as const)(
  "native entry rejects %s without reading secrets",
  async (_name, options) => {
    const f = await entryFixture(options);
    try {
      expect((await f.entry()).status).toBe(403);
      expect(f.reads()).toBe(0);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each([
  "stopping",
  "stopped",
  "failed",
  "paused",
  "create-intended",
  "delete-intended",
  "deleted",
  "rejected-create",
  "revoked",
  "demoted",
  "disabled",
  "directory-disabled",
  "frozen-source",
  "newer-failed-attempt",
] as const)(
  "native entry fails closed after %s",
  async (scenario) => {
    const f = await entryFixture();
    try {
      if (["stopping", "stopped"].includes(scenario))
        await f.database
          .client`UPDATE factory.runtime_attempt SET state=${scenario},stop_intended_at=now()
        WHERE id=${f.attemptID}`;
      else if (["failed", "paused", "create-intended"].includes(scenario))
        await f.database
          .client`UPDATE factory.runtime_attempt SET state=${scenario} WHERE id=${f.attemptID}`;
      else if (scenario === "delete-intended" || scenario === "deleted")
        await f.database.client`UPDATE factory.runtime_attempt SET delete_intended_at=now(),
        deleted_at=CASE WHEN ${scenario === "deleted"} THEN now() END WHERE id=${f.attemptID}`;
      else if (scenario === "rejected-create")
        await f.database.client`UPDATE factory.runtime_attempt SET create_rejected=true
        WHERE id=${f.attemptID}`;
      else if (scenario === "revoked")
        await f.database.client`DELETE FROM factory.project_membership
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      else if (scenario === "demoted")
        await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      else if (scenario === "disabled")
        await f.database
          .client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${f.userID}`;
      else if (scenario === "directory-disabled")
        await f.database
          .client`UPDATE factory.account_access SET directory_disabled_at=now() WHERE user_id=${f.userID}`;
      else if (scenario === "frozen-source")
        await f.database
          .client`UPDATE factory.substrate_source SET writable=false,writer_epoch=writer_epoch+1,
        checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
      else {
        // Even a failed newer generation fences an older apparently active row.
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
        await recordUncreatedWorkspaceAttempt(f.database, {
          workspaceID: f.workspaceID,
          generation: 2,
          createdBy: f.userID,
          parentHash: hashConnectorToken("newer-parent"),
          childHash: hashConnectorToken("newer-child"),
          connectorURL: "wss://factory.test/internal/runtime-connect",
          state: "failed",
        });
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
      }
      const response = await f.entry();
      expect([401, 403]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(f.reads()).toBe(0);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test("native entry uses the current Ticket writer rather than the immutable creator", async () => {
  const f = await entryFixture({ kind: "ticket" });
  try {
    expect((await f.entry()).status).toBe(200);
    const currentUser = crypto.randomUUID();
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${currentUser},'Current native writer',${`${currentUser}@factory.test`},true)`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${f.projectID},${currentUser},'developer',${f.userID})`;
      await sql`UPDATE factory.change_writer SET user_id=${currentUser},epoch=epoch+1
        WHERE change_id=${f.changeID}`;
      await sql`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    });
    expect((await f.entry()).status).toBe(200);
    await f.database
      .client`UPDATE factory.change_writer SET state='unassigned',user_id=NULL,epoch=epoch+1
      WHERE change_id=${f.changeID}`;
    const reads = f.reads();
    expect((await f.entry()).status).toBe(403);
    expect(f.reads()).toBe(reads);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("native entry preserves stored environment fingerprint, command and manifest checks", async () => {
  const f = await entryFixture();
  try {
    const [key, original] = [...f.stored.entries()][0] ?? [];
    if (!key || !original) throw new Error("Owned environment is missing");
    for (const altered of [
      undefined,
      { ...original, fingerprint: "0".repeat(64) },
      { ...original, commandID: crypto.randomUUID() },
      {
        ...original,
        bundle: { ...original.bundle, variables: original.bundle.variables.slice(1) },
      },
    ]) {
      if (altered) f.stored.set(key, altered);
      else f.stored.delete(key);
      const response = await f.entry();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("owned-RUNTIME-value");
    }
    f.stored.set(key, original);
    expect((await f.entry()).status).toBe(200);
  } finally {
    await f.dispose();
  }
}, 30_000);

test.each(["source", "authority", "deletion", "stop"] as const)(
  "native entry holds its %s grant through the secret read",
  async (change) => {
    const f = await entryFixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = f.secrets.read;
    let response: Promise<Response> | undefined;
    let revoking: Promise<unknown> | undefined;
    try {
      f.secrets.read = async (key) => {
        reading.resolve();
        await release.promise;
        return read(key);
      };
      response = f.entry();
      await reading.promise;
      revoking = f.database.client.begin(async (sql) => {
        if (change === "source")
          await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=writer_epoch+1,
            checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
        else if (change === "authority")
          await sql`DELETE FROM factory.project_membership
            WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
        else if (change === "deletion")
          await sql`UPDATE factory.runtime_attempt SET delete_intended_at=now()
            WHERE id=${f.attemptID}`;
        else
          await sql`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
            WHERE id=${f.attemptID}`;
      });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [wait] = await f.database.client<{ blocked: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND pid<>pg_backend_pid() AND wait_event_type='Lock') AS blocked`;
        if (wait?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      release.resolve();
      expect((await response).status).toBe(200);
      await revoking;
      const reads = f.reads();
      expect([401, 403]).toContain((await f.entry()).status);
      expect(f.reads()).toBe(reads);
    } finally {
      release.resolve();
      await Promise.allSettled([response, revoking]);
      await f.dispose();
    }
  },
  30_000,
);

test.each(["verification", "staging", "publication"] as const)(
  "native %s entry uses its exact product grant and waits for Parent Source without a Workspace lease",
  async (kind) => {
    const f = await isolatedEntryFixture(kind);
    try {
      expect(
        await f.database.client`SELECT workspace_id FROM factory.substrate_source
          WHERE workspace_id=${f.workspaceID}`,
      ).toHaveLength(0);
      const before = f.reads();
      f.setSourceConnected(false);
      expect((await f.entry()).status).toBe(409);
      expect(f.reads()).toBe(before);
      expect((await f.entry({ "X-Factory-Runtime-Actor-UID": crypto.randomUUID() })).status).toBe(
        403,
      );
      expect((await f.entry({ "X-Factory-Runtime-Generation": "2" })).status).toBe(401);
      f.setSourceConnected(true);
      const response = await f.entry();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const variables =
        kind === "publication"
          ? []
          : f.variables.filter(
              (variable) => variable.runtime && (kind !== "verification" || variable.verification),
            );
      expect(await response.json()).toEqual({
        version: kind === "publication" ? 0 : 1,
        bundle: { variables },
      });
      if (kind === "verification")
        await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
          WHERE id=${f.ownerID}`;
      else if (kind === "staging")
        await f.database.client`UPDATE factory.operation
          SET payload=jsonb_set(payload,'{revision}',to_jsonb(${"b".repeat(40)}::text)), updated_at=now()
          WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}
            AND idempotency_key=${`delivery.staging_preview:${f.projectID}`}`;
      else if (kind === "publication")
        await f.database
          .client`UPDATE factory.operation SET state='failed', updated_at=now() WHERE id=${f.ownerID} AND kind='releases.attempt'`;
      const reads = f.reads();
      expect((await f.entry()).status).toBe(403);
      // Disconnection cannot turn revoked authority into a retryable wait.
      f.setSourceConnected(false);
      expect((await f.entry()).status).toBe(403);
      expect(f.reads()).toBe(reads);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each(["verification", "staging", "publication"] as const)(
  "native %s membership uses its own frozen bytes, not another native owner or mutable Project configuration",
  async (kind) => {
    const template = JSON.parse(nativeProjectTemplate.content);
    template.containers[1].name = "frozen-service";
    const content = `${JSON.stringify(template)}\n`;
    const f = await isolatedEntryFixture(kind, {
      path: nativeProjectTemplate.path,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    try {
      await f.database
        .client`UPDATE factory.project SET actor_template_path='.factory/replaced.json'
        WHERE id=${f.projectID}`;
      const before = f.reads();
      // The Workspace fixture admits database. This isolated owner does not.
      expect(
        (
          await f.entry({
            "X-Factory-Runtime-Container": "database",
            authorization: `Bearer ${runtimeProjectEntryToken(secret, f.attemptID, 1, "database")}`,
          })
        ).status,
      ).toBe(403);
      expect(f.reads()).toBe(before);
      expect(
        (
          await f.entry({
            "X-Factory-Runtime-Container": "frozen-service",
            authorization: `Bearer ${runtimeProjectEntryToken(secret, f.attemptID, 1, "frozen-service")}`,
          })
        ).status,
      ).toBe(200);
      await f.database.client`DELETE FROM factory.project_membership
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      const reads = f.reads();
      expect((await f.entry()).status).toBe(403);
      expect(f.reads()).toBe(reads);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);
