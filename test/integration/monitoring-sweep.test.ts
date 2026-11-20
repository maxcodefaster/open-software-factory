import { expect, test } from "bun:test";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { createMonitoringController } from "../../apps/factory/src/monitoring/controller";
import { monitoringDigest } from "../../apps/factory/src/monitoring/payload";
import { createMonitoringWorker } from "../../apps/factory/src/monitoring/worker";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("Monitoring sweeps reach the tail and wrap to new arrivals while the first fifty projects stay busy", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const userId = crypto.randomUUID();
  const controller = createMonitoringController(
    database,
    "owned-sweep-key",
    "https://factory.example",
    () => {},
  );
  const mcp = createMCPConnections(
    database,
    {
      configured: false,
      read: async () => undefined,
      create: async () => {
        throw new Error("The sweep fixture does not use credentials");
      },
    },
    "owned-sweep-key",
    "https://factory.example",
  );
  const finish = Promise.withResolvers<void>();
  const starts: string[] = [];
  const environment = {
    FACTORY_PROJECT_AGENT_MODEL: "owned-sweep-model",
    FACTORY_PLANNING_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
    FACTORY_PLANNING_MODEL_API_KEY: "owned-unused-key",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  const worker = createMonitoringWorker(database, {
    mcp,
    code: {
      codePaths: async () => {
        throw new Error("The sweep fixture has no source reads");
      },
      code: async () => {
        throw new Error("The sweep fixture has no source reads");
      },
    },
    changes: {
      start: async () => {
        throw new Error("The sweep fixture cannot implement");
      },
    },
    agent: {
      admitStartIn: async () => {
        throw new Error("The sweep fixture cannot admit Build");
      },
    },
    delivery: {
      get: async () => null,
      approve: async () => {
        throw new Error("The sweep fixture cannot deliver");
      },
    },
    signingKey: "owned-sweep-key",
    prepare: async (input) => {
      starts.push(input.projectId);
      await finish.promise;
      return {
        outcome: "insufficient-context",
        explanation: "Owned controlled preparation with no model calls.",
        title: "Owned sweep",
        requirements: null,
        code: [],
      };
    },
  });
  const projectId = (ordinal: number) =>
    `10000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
  async function seed(ordinal: number) {
    const id = projectId(ordinal);
    const hookId = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${id},${`owned-sweep-${ordinal}`},'Owned sweep Project','https://forge.example/owned/sweep.git',
        'main','.devcontainer/devcontainer.json',${userId})`;
    await controller.save(id, userId, {
      id: hookId,
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      name: "Owned sweep Input",
      enabled: true,
      delegation: "prepare-ticket",
    });
    // A second queued incident keeps busy projects eligible for later sweeps.
    for (const event of [1, 2])
      await database.client`INSERT INTO factory.monitoring_incident(id,hook_id,project_id,policy_id,hook_version,
        fingerprint,payload_digest,title,context,state)
        SELECT ${crypto.randomUUID()},id,project_id,policy_id,version,${monitoringDigest(String(event))},
          ${monitoringDigest("owned-payload")},'Owned sweep','Owned controlled context','queued'
        FROM factory.monitoring_hook WHERE id=${hookId}`;
    return id;
  }
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userId},'Owned sweep manager',${`${userId}@sweep.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userId})`;
    const initial: string[] = [];
    for (let ordinal = 10; ordinal <= 600; ordinal += 10) initial.push(await seed(ordinal));
    await worker.sweep();
    await eventually(
      async () => starts.length,
      (count) => count === 50,
      "The first bounded sweep did not admit fifty projects",
      3_000,
    );
    expect([...starts].sort()).toEqual(initial.slice(0, 50));
    const earlyArrival = await seed(15);
    const lateArrival = await seed(650);
    await worker.sweep();
    await eventually(
      async () => starts.length,
      (count) => count === 62,
      "Persistent busy projects starved the tail or new arrivals",
      3_000,
    );
    expect([...starts].sort()).toEqual([...initial, earlyArrival, lateArrival].sort());
    // Wrapping across running owners must not admit their second queued incident.
    await worker.sweep();
    expect(starts).toHaveLength(62);
    const [counts] = await database.client<{ diagnosing: number; queued: number }[]>`
      SELECT count(*) FILTER (WHERE state='diagnosing')::int AS diagnosing,
        count(*) FILTER (WHERE state='queued')::int AS queued FROM factory.monitoring_incident`;
    expect(counts).toEqual({ diagnosing: 62, queued: 62 });
  } finally {
    finish.resolve();
    await worker.close();
    await database.client.end();
    await host.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 60_000);
