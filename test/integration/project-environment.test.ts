import { expect, test } from "bun:test";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type {
  EnvironmentSecrets,
  StoredEnvironment,
} from "../../apps/factory/src/environments/openbao";
import { factoryProcess } from "../fixtures/factory-process";

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
        [manager, "developer"],
        [developer, "developer"],
        [contributor, "product-contributor"],
      ])
        await sql`INSERT INTO factory.project_membership(project_id, user_id, role, manage_project, updated_by)
          VALUES (${projectID}, ${userID!}, ${role!}, ${userID === manager}, ${manager})`;
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
