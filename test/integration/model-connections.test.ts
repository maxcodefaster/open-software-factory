import { expect, test } from "bun:test";
import { createModelConnections } from "../../apps/factory/src/models/connections";
import type { ModelSecrets, StoredModelConnection } from "../../apps/factory/src/models/secrets";
import { factoryProcess } from "../fixtures/factory-process";
import type { ModelProbeResult } from "../../packages/conversation-domain/src/model-connection";
import { createModelSettingsController } from "../../apps/factory/src/models/controller";

test("role probes are admitted once, replay without inference and fence delayed settings writes", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = crypto.randomUUID();
  const connectionID = crypto.randomUUID();
  const stored = new Map<string, StoredModelConnection>();
  let calls = 0;
  const slow = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const ready = (id: string): ModelProbeResult => ({
    status: "ready",
    modelId: id,
    toolCall: true,
    structuredOutput: true,
    limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
  });
  const controller = createModelConnections(
    database,
    {
      configured: true,
      read: async (key) => stored.get(key),
      create: async (key, value) => {
        stored.set(key, value);
      },
    },
    "owned-probe-key",
    [],
    async ({ modelId }) => {
      calls++;
      if (modelId === "slow-model") {
        admitted.resolve();
        await slow.promise;
      }
      return ready(modelId);
    },
  );
  try {
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified) VALUES (${manager}, 'Owned manager', ${`${manager}@provider.test`}, true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES (${manager})`;
    await controller.save(manager, {
      commandID: crypto.randomUUID(),
      connectionID,
      version: 0,
      provider: "anthropic",
      endpoint: null,
      apiKey: "protected-test-key",
    });
    const first = {
      commandID: crypto.randomUUID(),
      settingsVersion: 0,
      connectionID,
      version: 1,
      role: "planning" as const,
      modelId: "slow-model",
      confirmInference: true as const,
    };
    const pending = controller.selectRole(manager, first, new AbortController().signal);
    await admitted.promise;
    await expect(
      controller.selectRole(manager, first, new AbortController().signal),
    ).rejects.toThrow("already admitted");
    const next = { ...first, commandID: crypto.randomUUID(), modelId: "fast-model" };
    expect((await controller.selectRole(manager, next, new AbortController().signal)).status).toBe(
      "ready",
    );
    slow.resolve();
    expect((await pending).status).toBe("superseded");
    expect((await controller.selectRole(manager, next, new AbortController().signal)).status).toBe(
      "ready",
    );
    expect((await controller.selectRole(manager, first, new AbortController().signal)).status).toBe(
      "superseded",
    );
    expect(calls).toBe(2);
    expect(await controller.roles(manager)).toContainEqual(
      expect.objectContaining({
        role: "planning",
        active: { connectionID, version: 1, modelId: "fast-model" },
      }),
    );
    const settings = await createModelSettingsController(database).get();
    expect(settings.source).toBe("administrator");
    expect(settings.version).toBe(1);
    expect(settings.planningModelId).toBe("fast-model");
    await expect(
      controller.selectRole(
        manager,
        { ...next, commandID: crypto.randomUUID() },
        new AbortController().signal,
      ),
    ).rejects.toThrow("changed");
    expect(calls).toBe(2);
    await expect(
      (async () => {
        await database.client`UPDATE factory.model_role_probe SET model_id='other' WHERE command_id=${first.commandID}`;
      })(),
    ).rejects.toThrow("immutable");
    expect(
      JSON.stringify(
        await database.client`SELECT row_to_json(probe) FROM factory.model_role_probe probe`,
      ),
    ).not.toContain("protected-test-key");
  } finally {
    slow.resolve();
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 60_000);

test("provider saves persist intent before OpenBao, recover response loss, mask reads and retain exact versions", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = "01994a7d-0000-7000-8000-000000000001";
  const outsider = crypto.randomUUID();
  const connectionID = crypto.randomUUID();
  const stored = new Map<string, StoredModelConnection>();
  let writes = 0;
  let loseResponse = true;
  const secrets: ModelSecrets = {
    configured: true,
    read: async (key) => stored.get(key),
    async create(key, value) {
      const [intent] =
        await database.client`SELECT command_id FROM factory.model_connection_write WHERE secret_key=${key}`;
      expect(intent).toBeDefined();
      expect(stored.has(key)).toBe(false);
      writes++;
      stored.set(key, value);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost OpenBao acknowledgement");
      }
    },
  };
  try {
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified) VALUES (${manager}, 'Owned manager', 'manager@provider.test', true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES (${manager})`;
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified) VALUES (${outsider}, 'Owned provider test', ${`${outsider}@provider.test`}, true)`;
    const controller = createModelConnections(database, secrets, "owned-provider-fingerprint-key");
    const input = {
      commandID: crypto.randomUUID(),
      connectionID,
      version: 0,
      provider: "anthropic" as const,
      endpoint: null,
      apiKey: "owned-secret-first",
    };
    await expect(controller.save(outsider, input)).rejects.toThrow("System Manager");
    expect(writes).toBe(0);
    const result = await controller.save(manager, input);
    expect(result).toMatchObject({
      version: 1,
      configured: true,
      pendingCommandID: null,
      provider: "anthropic",
    });
    expect(JSON.stringify(result)).not.toContain("owned-secret");
    expect((await controller.save(manager, input)).version).toBe(1);
    expect(writes).toBe(1);
    await expect(controller.save(manager, { ...input, apiKey: "changed-replay" })).rejects.toThrow(
      "changed",
    );
    await expect(controller.list(outsider)).rejects.toThrow("System Manager");
    const next = {
      ...input,
      version: 1,
      commandID: crypto.randomUUID(),
      apiKey: "owned-secret-second",
    };
    const parallel = await Promise.allSettled([
      controller.save(manager, next),
      controller.save(manager, { ...next, commandID: crypto.randomUUID() }),
    ]);
    expect(parallel.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(writes).toBe(2);
    expect((await controller.resolve(connectionID, 1)).apiKey).toBe("owned-secret-first");
    expect((await controller.resolve(connectionID, 2)).apiKey).toBe("owned-secret-second");
    expect(
      (
        await createModelConnections(database, secrets, "owned-provider-fingerprint-key").get(
          connectionID,
          manager,
        )
      ).version,
    ).toBe(2);
    const rows =
      await database.client`SELECT row_to_json(row) AS data FROM factory.model_connection_write row WHERE connection_id=${connectionID}`;
    expect(JSON.stringify(rows)).not.toContain("owned-secret");
    const versions =
      await database.client`SELECT row_to_json(row) AS data FROM factory.model_connection_version row WHERE connection_id=${connectionID}`;
    expect(JSON.stringify(versions)).not.toContain("owned-secret");
    await expect(
      (async () => {
        await database.client`UPDATE factory.model_connection_version SET endpoint='https://unsafe.test' WHERE connection_id=${connectionID}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      controller.save(manager, {
        ...next,
        commandID: crypto.randomUUID(),
        version: 2,
        endpoint: "https://not-allowed.test/v1",
      }),
    ).rejects.toThrow("not allowed");
    expect(writes).toBe(2);
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 60_000);

test("restart recovers stored provider write without resubmitting or losing active credentials", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = "01994a7d-0000-7000-8000-000000000001";
  const connectionID = crypto.randomUUID();
  const stored = new Map<string, StoredModelConnection>();
  let inaccessible = false;
  const secrets: ModelSecrets = {
    configured: true,
    async read(key) {
      if (inaccessible) throw new Error("store inaccessible");
      return stored.get(key);
    },
    async create(key, value) {
      stored.set(key, value);
      inaccessible = true;
      throw new Error("lost response");
    },
  };
  try {
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified) VALUES (${manager}, 'Owned manager', 'manager@provider.test', true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES (${manager})`;
    const controller = createModelConnections(database, secrets, "owned-provider-key");
    const input = {
      commandID: crypto.randomUUID(),
      connectionID,
      version: 0,
      provider: "deepseek" as const,
      endpoint: null,
      apiKey: "owned-pending-value",
    };
    await expect(controller.save(manager, input)).rejects.toThrow();
    const pending = await controller.get(connectionID, manager);
    expect(pending.configured).toBe(false);
    expect(pending.pendingCommandID).toBe(input.commandID);
    inaccessible = false;
    await createModelConnections(database, secrets, "owned-provider-key").recover();
    expect((await controller.get(connectionID, manager)).version).toBe(1);
    expect(stored.size).toBe(1);
    expect((await controller.resolve(connectionID, 1)).apiKey).toBe("owned-pending-value");
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);

test("Coding model and reasoning adopt atomically after the exact probe and fence changed replays", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = crypto.randomUUID();
  const stored = new Map<string, StoredModelConnection>();
  const observed: unknown[] = [];
  let status: ModelProbeResult["status"] = "ready";
  const controller = createModelConnections(
    database,
    {
      configured: true,
      read: async (key) => stored.get(key),
      create: async (key, value) => {
        stored.set(key, value);
      },
    },
    "owned-atomic-reasoning",
    [],
    async ({ modelId, reasoningEffort }) => {
      observed.push({ modelId, reasoningEffort });
      return {
        status,
        modelId,
        toolCall: status === "ready",
        structuredOutput: false,
        limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
      };
    },
  );
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES (${manager},'Owned manager',${`${manager}@reasoning.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES (${manager})`;
    const connection = await controller.save(manager, {
      commandID: crypto.randomUUID(),
      connectionID: crypto.randomUUID(),
      version: 0,
      provider: "openai",
      endpoint: null,
      apiKey: "owned-not-a-real-key",
    });
    const input = {
      commandID: crypto.randomUUID(),
      connectionID: connection.connectionID,
      version: 1,
      settingsVersion: 0,
      role: "build" as const,
      modelId: "owned-sol",
      reasoningEffort: "high" as const,
      confirmInference: true as const,
    };
    expect((await controller.selectRole(manager, input, new AbortController().signal)).status).toBe(
      "ready",
    );
    expect(observed).toEqual([{ modelId: "owned-sol", reasoningEffort: "high" }]);
    const settings = createModelSettingsController(database);
    const adopted = await settings.get();
    expect(adopted.buildModelId).toBe("owned-sol");
    expect(adopted.rules.build.reasoningEffort).toBe("high");
    expect((await controller.selectRole(manager, input, new AbortController().signal)).status).toBe(
      "ready",
    );
    await expect(
      controller.selectRole(
        manager,
        { ...input, reasoningEffort: "max" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("changed");
    expect(observed).toHaveLength(1);
    status = "unsupported";
    await controller.selectRole(
      manager,
      {
        ...input,
        commandID: crypto.randomUUID(),
        settingsVersion: adopted.version,
        modelId: "unsupported-model",
        reasoningEffort: "max",
      },
      new AbortController().signal,
    );
    expect(await settings.get()).toEqual(adopted);
    await expect(
      (async () => {
        await database.client`UPDATE factory.model_role_probe SET reasoning_effort='max' WHERE command_id=${input.commandID}`;
      })(),
    ).rejects.toThrow("immutable");
    const permitted = await settings.set(
      {
        version: adopted.version,
        planningModelId: adopted.planningModelId,
        buildModelId: adopted.buildModelId,
        rules: {
          ...adopted.rules,
          build: { ...adopted.rules.build, models: ["owned-sol", "gpt-4"], allowOverride: false },
        },
      },
      manager,
    );
    status = "ready";
    await controller.selectRole(
      manager,
      {
        ...input,
        commandID: crypto.randomUUID(),
        settingsVersion: permitted.version,
        reasoningEffort: "max",
      },
      new AbortController().signal,
    );
    const changed = await settings.get();
    expect(changed.rules.build).toEqual({
      models: ["owned-sol", "gpt-4"],
      allowOverride: false,
      reasoningEffort: "max",
    });
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
