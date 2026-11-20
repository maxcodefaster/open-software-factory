import { expect, test } from "bun:test";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type {
  EnvironmentSecrets,
  StoredEnvironment,
} from "../../apps/factory/src/environments/openbao";
import {
  environmentManifest,
  environmentMetadata,
} from "../../packages/project-domain/src/environment";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("environment writes persist intent, recover ambiguous outcomes, mask reads and enforce scope", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const projectID = crypto.randomUUID();
  const manager = crypto.randomUUID();
  const developer = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  const stored = new Map<string, StoredEnvironment>();
  let loseResponse = true;
  let writes = 0;
  const secrets: EnvironmentSecrets = {
    configured: true,
    async read(key) {
      return stored.get(key);
    },
    async create(key, value) {
      const [intent] =
        await database.client`SELECT command_id FROM factory.environment_write WHERE secret_key=${key}`;
      expect(intent).toBeDefined();
      writes += 1;
      stored.set(key, value);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost acknowledgement");
      }
    },
  };
  try {
    await database.client.begin(async (sql) => {
      for (const userID of [manager, developer, contributor, outsider])
        await sql`INSERT INTO auth."user"(id, name, email, email_verified)
          VALUES (${userID}, 'Owned environment test', ${`${userID}@environment.test`}, true)`;
      await sql`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${projectID}, ${`environment-${projectID}`}, 'Owned environment', 'https://example.invalid/owned.git',
          'main', '.devcontainer/devcontainer.json', ${manager})`;
      for (const [userID, role] of [
        [manager, "product-contributor"],
        [developer, "developer"],
        [contributor, "product-contributor"],
      ])
        await sql`INSERT INTO factory.project_membership(project_id, user_id, role, manage_project, updated_by)
          VALUES (${projectID}, ${fixtureValue(userID, "userID")}, ${fixtureValue(role, "role")}, ${userID === manager}, ${manager})`;
    });
    const controller = createEnvironmentController(
      database,
      secrets,
      "owned-environment-signing-key",
    );
    const input = {
      commandID: crypto.randomUUID(),
      version: 0,
      variables: [
        {
          name: "API_KEY",
          value: "secret-runtime-value",
          runtime: true,
          build: false,
          verification: false,
        },
      ],
      registries: [
        {
          host: "registry.example.com",
          username: "robot",
          password: "secret-registry-value",
          verification: false,
        },
      ],
    };
    await expect(controller.save(projectID, developer, "development", input)).rejects.toThrow(
      "Manager",
    );
    await expect(controller.get(projectID, outsider, "development")).rejects.toThrow("not found");
    await expect(controller.get(projectID, contributor, "development")).rejects.toThrow(
      "Developer",
    );
    const result = await controller.save(projectID, manager, "development", input);
    expect(result.version).toBe(1);
    expect(result.pending).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(writes).toBe(1);
    expect((await controller.save(projectID, manager, "development", input)).version).toBe(1);
    expect(writes).toBe(1);
    expect((await controller.get(projectID, developer, "development")).canManage).toBe(false);
    expect((await controller.get(projectID, manager, "main-preview")).variables).toEqual([]);
    const rows =
      await database.client`SELECT row_to_json(row) AS value FROM factory.environment_write row WHERE project_id=${projectID}`;
    expect(JSON.stringify(rows)).not.toContain("secret-runtime-value");
    expect(JSON.stringify(rows)).not.toContain("secret-registry-value");
    const next = {
      ...input,
      commandID: crypto.randomUUID(),
      version: 1,
      variables: input.variables.map(({ value: _value, ...metadata }) => metadata),
      registries: input.registries.map(({ password: _password, ...metadata }) => metadata),
    };
    const concurrent = await Promise.allSettled([
      controller.save(projectID, manager, "development", next),
      controller.save(projectID, manager, "development", {
        ...next,
        commandID: crypto.randomUUID(),
      }),
    ]);
    expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect((await controller.get(projectID, manager, "development")).version).toBe(2);
    expect([...stored.values()].at(-1)?.bundle.variables[0]?.value).toBe("secret-runtime-value");
    const [winner] = await database.client<
      Array<{ commandID: string }>
    >`SELECT command_id AS "commandID" FROM factory.environment_write WHERE project_id=${projectID} AND base_version=1 AND state='committed'`;
    if (!winner) throw new Error("Concurrent winner missing");
    await database.client`UPDATE factory.environment_write SET state='write-intended', committed_at=NULL
      WHERE command_id=${winner.commandID}`;
    await database.client`UPDATE factory.project_environment SET version=1 WHERE project_id=${projectID} AND environment='development'`;
    const recovered = createEnvironmentController(
      database,
      secrets,
      "owned-environment-signing-key",
    );
    await recovered.recover();
    expect((await recovered.get(projectID, manager, "development")).version).toBe(2);
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delayed = createEnvironmentController(
      database,
      {
        ...secrets,
        async create(key, value) {
          blocked.resolve();
          await release.promise;
          stored.set(key, value);
        },
      },
      "owned-environment-signing-key",
    );
    const delayedInput = { ...next, version: 2, commandID: crypto.randomUUID() };
    const saving = delayed.save(projectID, manager, "development", delayedInput).then(
      () => "saved",
      () => "discarded",
    );
    await blocked.promise;
    expect((await controller.get(projectID, manager, "development")).pendingCommandID).toBe(
      delayedInput.commandID,
    );
    await expect(
      controller.discard(projectID, developer, "development", delayedInput.commandID),
    ).rejects.toThrow("Manager");
    expect(
      (await controller.discard(projectID, manager, "development", delayedInput.commandID)).pending,
    ).toBe(false);
    release.resolve();
    expect(await saving).toBe("discarded");
    await recovered.recover();
    expect((await controller.get(projectID, manager, "development")).version).toBe(2);
    await expect(controller.save(projectID, manager, "development", delayedInput)).rejects.toThrow(
      "changed",
    );
    for (const revoked of ["management", "account"] as const) {
      const commandID = crypto.randomUUID();
      const secretKey = `projects/${projectID}/development/${commandID}`;
      const previous = fixtureValue(
        stored.get(`projects/${projectID}/development/${winner.commandID}`),
        `stored.get(\`projects/\${projectID}/development/\${winner.commandID}\`)`,
      );
      stored.set(secretKey, { ...previous, commandID });
      await database.client`INSERT INTO factory.environment_write(command_id,project_id,environment,
        base_version,fingerprint,manifest,secret_key,created_by)
        SELECT ${commandID},project_id,environment,2,fingerprint,manifest,${secretKey},created_by
        FROM factory.environment_write WHERE command_id=${winner.commandID}`;
      if (revoked === "management")
        await database.client`UPDATE factory.project_membership SET manage_project=false
          WHERE project_id=${projectID} AND user_id=${manager}`;
      else
        await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${manager}`;
      await recovered.recover();
      const [environment] = await database.client<Array<{ version: number }>>`
        SELECT version::float8 AS version FROM factory.project_environment
        WHERE project_id=${projectID} AND environment='development'`;
      expect(environment?.version).toBe(2);
      const [intent] = await database.client<Array<{ state: string }>>`
        SELECT state FROM factory.environment_write WHERE command_id=${commandID}`;
      expect(intent?.state).toBe("discarded");
      await database.client`UPDATE factory.project_membership SET manage_project=true
        WHERE project_id=${projectID} AND user_id=${manager}`;
      await database.client`UPDATE factory.account_access SET disabled_at=NULL WHERE user_id=${manager}`;
    }
    const unavailable = createEnvironmentController(
      database,
      { configured: false, read: secrets.read, create: secrets.create },
      "owned-environment-signing-key",
    );
    await expect(
      unavailable.save(projectID, manager, "main-preview", {
        ...input,
        commandID: crypto.randomUUID(),
      }),
    ).rejects.toThrow("not configured");
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);

test("environment retries preserve exact versions and manifests, and settlement rolls back on the locked transaction", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const projectID = crypto.randomUUID();
  const manager = crypto.randomUUID();
  const stored = new Map<string, StoredEnvironment>();
  const writes: string[] = [];
  let unconfirmed = false;
  const secrets: EnvironmentSecrets = {
    configured: true,
    async read(key) {
      return stored.get(key);
    },
    async create(key, value) {
      const [intent] = await database.client<
        Array<{ state: string; manifest: unknown; secretKey: string }>
      >`SELECT state, manifest, secret_key AS "secretKey" FROM factory.environment_write
        WHERE command_id=${value.commandID}`;
      expect(intent?.state).toBe("write-intended");
      expect(intent?.secretKey).toBe(key);
      expect(intent?.manifest).toEqual(environmentMetadata(value.bundle));
      expect(typeof intent?.manifest).toBe("object");
      writes.push(key);
      if (unconfirmed) throw new Error("Write outcome unknown");
      stored.set(key, value);
    },
  };
  try {
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id, name, email, email_verified)
        VALUES (${manager}, 'Owned retry manager', ${`${manager}@environment.test`}, true)`;
      await sql`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${projectID}, ${`environment-${projectID}`}, 'Owned retry environment',
          'https://example.invalid/owned.git', 'main', '.devcontainer/devcontainer.json', ${manager})`;
      await sql`INSERT INTO factory.project_membership(project_id, user_id, role, manage_project, updated_by)
        VALUES (${projectID}, ${manager}, 'product-contributor', true, ${manager})`;
    });
    const controller = createEnvironmentController(database, secrets, "owned-retry-signing-key");
    const initial = {
      commandID: crypto.randomUUID(),
      version: 0,
      variables: [
        {
          name: "RUNTIME_KEY",
          value: "protected-runtime-value",
          runtime: true,
          build: false,
          verification: false,
        },
        {
          name: "BUILD_KEY",
          value: "protected-build-value",
          runtime: false,
          build: true,
          verification: true,
        },
      ],
      registries: [
        {
          host: "registry.example.com:5443",
          username: "owned-robot",
          password: "protected-password",
          certificate:
            "-----BEGIN CERTIFICATE-----\nprotected-certificate\n-----END CERTIFICATE-----",
          verification: false,
          publish: true,
        },
      ],
    };
    await controller.save(projectID, manager, "development", initial);
    const originalKey = `projects/${projectID}/development/${initial.commandID}`;
    const original = fixtureValue(stored.get(originalKey), "original stored environment");
    const version = 4_294_967_299;
    await database.client`UPDATE factory.project_environment SET version=${version}
      WHERE project_id=${projectID} AND environment='development'`;
    for (const [environment, environmentVersion, state, createdAt, revision] of [
      ["development", version, "failed", "2026-01-01T00:00:00Z", "a"],
      ["development", version, "unsupported", "2026-01-02T00:00:00Z", "b"],
      ["development", version + 2, "running", "2026-01-03T00:00:00Z", "c"],
      ["main-preview", version, "pending", "2026-01-04T00:00:00Z", "d"],
    ] as const)
      await database.client`INSERT INTO factory.project_image_preparation(
        id, project_id, environment, revision, environment_version, state, created_at)
        VALUES (${crypto.randomUUID()}, ${projectID}, ${environment}, ${revision.repeat(40)},
          ${environmentVersion}, ${state}, ${createdAt})`;
    const active = await controller.get(projectID, manager, "development");
    expect(active.version).toBe(version);
    expect(active.preparation).toBe("unsupported");
    expect(active.variables).toEqual(environmentMetadata(original.bundle).variables);
    expect(active.registries).toEqual(environmentMetadata(original.bundle).registries);
    const next = {
      commandID: crypto.randomUUID(),
      version,
      variables: initial.variables.map(({ value: _value, ...metadata }) => metadata),
      registries: initial.registries.map(
        ({ password: _password, certificate: _certificate, ...metadata }) => metadata,
      ),
    };
    await expect(
      controller.save(projectID, manager, "development", { ...next, version: version - 1 }),
    ).rejects.toThrow("changed");
    expect(writes).toHaveLength(1);
    unconfirmed = true;
    await expect(controller.save(projectID, manager, "development", next)).rejects.toThrow(
      "unconfirmed",
    );
    const pending = await controller.get(projectID, manager, "development");
    expect(pending.version).toBe(version);
    expect(pending.pendingCommandID).toBe(next.commandID);
    expect(pending.preparation).toBe("unsupported");
    expect((await controller.get(projectID, manager, "main-preview")).pending).toBe(false);
    await controller.recover();
    expect(writes).toHaveLength(2);
    await expect(
      controller.save(projectID, manager, "development", {
        ...next,
        variables: next.variables.map((variable) => ({ ...variable, verification: false })),
      }),
    ).rejects.toThrow("changed");
    await expect(
      controller.save(projectID, manager, "development", {
        ...next,
        commandID: crypto.randomUUID(),
      }),
    ).rejects.toThrow("changed");
    await expect(
      controller.discard(projectID, manager, "main-preview", next.commandID),
    ).rejects.toThrow("changed");
    expect(writes).toHaveLength(2);

    await database.client`CREATE FUNCTION factory.reject_environment_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.state = 'committed' THEN RAISE EXCEPTION 'owned settlement rollback'; END IF;
        RETURN NEW;
      END $$`;
    await database.client`CREATE TRIGGER owned_environment_commit_failure
      BEFORE UPDATE ON factory.environment_write
      FOR EACH ROW EXECUTE FUNCTION factory.reject_environment_commit()`;
    unconfirmed = false;
    const replay = {
      registries: next.registries.map(({ host, username, verification, publish }) => ({
        publish,
        verification,
        username,
        host,
      })),
      variables: next.variables.map(({ name, runtime, build, verification }) => ({
        name,
        verification,
        build,
        runtime,
      })),
      version,
      commandID: next.commandID,
    };
    await expect(controller.save(projectID, manager, "development", replay)).rejects.toMatchObject({
      cause: { message: "owned settlement rollback" },
    });
    const nextKey = `projects/${projectID}/development/${next.commandID}`;
    expect(writes).toEqual([originalKey, nextKey, nextKey]);
    expect(stored.get(nextKey)?.bundle).toEqual(original.bundle);
    const [unchanged] = await database.client<
      Array<{ version: number; secretKey: string; manifest: unknown }>
    >`SELECT version::float8 AS version, secret_key AS "secretKey", manifest
      FROM factory.project_environment WHERE project_id=${projectID} AND environment='development'`;
    expect(unchanged?.version).toBe(version);
    expect(unchanged?.secretKey).toBe(originalKey);
    expect(environmentManifest.parse(unchanged?.manifest)).toEqual(
      environmentMetadata(original.bundle),
    );
    const [intent] = await database.client<
      Array<{ state: string; committedAt: Date | null }>
    >`SELECT state, committed_at AS "committedAt" FROM factory.environment_write
      WHERE command_id=${next.commandID}`;
    expect(intent).toEqual({ state: "write-intended", committedAt: null });
    await database.client`DROP TRIGGER owned_environment_commit_failure ON factory.environment_write`;
    await database.client`DROP FUNCTION factory.reject_environment_commit()`;
    await controller.recover();
    const result = await controller.get(projectID, manager, "development");
    expect(result.version).toBe(version + 1);
    expect(result.pending).toBe(false);
    expect(result.preparation).toBeNull();
    expect(result.variables).toEqual(active.variables);
    expect(result.registries).toEqual(active.registries);
    expect(JSON.stringify(result)).not.toContain("protected-");
    expect((await controller.save(projectID, manager, "development", replay)).version).toBe(
      version + 1,
    );
    expect(writes).toHaveLength(3);
    expect(stored.get(originalKey)).toEqual(original);
    const [committed] = await database.client<
      Array<{ state: string; committedAt: Date | null }>
    >`SELECT state, committed_at AS "committedAt" FROM factory.environment_write
      WHERE command_id=${next.commandID}`;
    expect(committed?.state).toBe("committed");
    expect(committed?.committedAt).not.toBeNull();
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
