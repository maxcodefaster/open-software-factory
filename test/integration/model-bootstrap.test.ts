import { expect, test } from "bun:test";
import { createModelConnections } from "../../apps/factory/src/models/connections";
import { createModelSettingsController } from "../../apps/factory/src/models/controller";
import type { StoredModelConnection } from "../../apps/factory/src/models/secrets";
import { factoryProcess } from "../fixtures/factory-process";

test("bootstrap recognizes a managed Coding connection without deployment credentials or another probe", async () => {
  const host = await factoryProcess(undefined, {
    FACTORY_MODEL_BASE_URL: "",
    FACTORY_MODEL_API_KEY: "",
    FACTORY_PLANNING_MODEL_BASE_URL: "",
    FACTORY_PLANNING_MODEL_API_KEY: "",
  });
  const database = host.connect();
  const stored = new Map<string, StoredModelConnection>();
  let probes = 0,
    reads = 0;
  const connections = createModelConnections(
    database,
    {
      configured: true,
      read: async (key) => {
        reads++;
        return stored.get(key);
      },
      create: async (key, value) => {
        stored.set(key, value);
      },
    },
    "owned-bootstrap-connection-key",
    [],
    async ({ modelId }) => {
      probes++;
      return {
        status: "ready",
        modelId,
        toolCall: true,
        structuredOutput: true,
        limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
      };
    },
  );
  try {
    await host.start();
    const cookie = await host.signIn();
    const bootstrap = async () => {
      const response = await fetch(`${host.base}/api/session`, { headers: { cookie } });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const initial = await bootstrap();
    const userID = initial.session.user.id as string;
    expect(initial.modelRelayConfigured).toBe(false);
    const connectionID = crypto.randomUUID();
    await connections.save(userID, {
      commandID: crypto.randomUUID(),
      connectionID,
      version: 0,
      provider: "openai",
      endpoint: null,
      apiKey: "owned-model-bootstrap-not-a-real-key",
    });
    for (const role of ["planning", "build"] as const) {
      const settings = await createModelSettingsController(database).get();
      await connections.selectRole(
        userID,
        {
          commandID: crypto.randomUUID(),
          settingsVersion: settings.version,
          connectionID,
          version: 1,
          role,
          modelId: `owned-${role}-model`,
          confirmInference: true,
        },
        new AbortController().signal,
      );
      const before = { probes, reads };
      expect((await bootstrap()).modelRelayConfigured).toBe(role === "build");
      expect({ probes, reads }).toEqual(before);
    }
    expect(probes).toBe(2);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 60_000);
