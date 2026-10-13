import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localOpenBao } from "../../scripts/factory/openbao";
import { factoryProcess } from "../fixtures/factory-process";
import { createModelConnections } from "../../apps/factory/src/models/connections";
import { createModelConnectionRoutes } from "../../apps/factory/src/models/connection-routes";
import { createOpenBaoModelSecrets } from "../../apps/factory/src/models/secrets";
import { deploymentModelConnections } from "../../apps/factory/src/models/deployment";
import { createModelSettingsController } from "../../apps/factory/src/models/controller";
import {
  modelConnectionView,
  modelProbeResult,
} from "../../packages/conversation-domain/src/model-connection";

test.skipIf(process.env["FACTORY_RUN_MODEL_BOOTSTRAP_PROOF"] !== "1")(
  "real deployment adoption encrypts two role connections and probes native transports without a Project",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-owned-model-bootstrap-"));
    const bao = await localOpenBao(directory);
    const configuration = await bao.start();
    const factory = await factoryProcess();
    const database = factory.connect();
    const manager = crypto.randomUUID();
    const signingKey = "owned-model-bootstrap-fingerprint";
    const secrets = createOpenBaoModelSecrets({
      address: configuration.FACTORY_OPENBAO_URL,
      tokenFile: configuration.FACTORY_OPENBAO_TOKEN_FILE,
      caFile: configuration.FACTORY_OPENBAO_CA_FILE,
    });
    const connections = createModelConnections(database, secrets, signingKey);
    const routes = createModelConnectionRoutes(
      connections,
      async (userID) => {
        if (userID !== manager) throw new Error("System Manager required");
      },
      signingKey,
    );
    try {
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${manager},'Owned model bootstrap',${`${manager}@models.test`})`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
      const catalogue = await routes(
        new Request("https://factory.test/api/model-connections"),
        manager,
      );
      const metadata = await catalogue?.json();
      expect(metadata.deployment).toHaveLength(2);
      for (const connection of deploymentModelConnections(signingKey)) {
        expect(connection.configured).toBe(true);
        if (!connection.apiKey) throw new Error("Live credential required");
        expect(JSON.stringify(metadata)).not.toContain(connection.apiKey);
        const command = { role: connection.role, commandID: crypto.randomUUID(), version: 0 };
        const request = () =>
          new Request("https://factory.test/api/model-connections/deployment", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(command),
          });
        const response = await routes(request(), manager);
        expect(response?.status).toBe(200);
        const saved = modelConnectionView.parse(await response?.json());
        const replay = await routes(request(), manager);
        expect(modelConnectionView.parse(await replay?.json()).version).toBe(1);
        const settings = await createModelSettingsController(database).get();
        const probe = {
          commandID: crypto.randomUUID(),
          settingsVersion: settings.version,
          connectionID: saved.connectionID,
          version: saved.version,
          role: connection.role,
          modelId: connection.modelId,
          confirmInference: true as const,
        };
        const started = performance.now();
        const result = modelProbeResult.parse(
          await connections.selectRole(manager, probe, AbortSignal.timeout(20_000)),
        );
        console.log(
          JSON.stringify({
            role: connection.role,
            model: result.modelId,
            status: result.status,
            elapsedMS: Math.round(performance.now() - started),
            limits: result.limits,
          }),
        );
        expect(result.status).toBe("ready");
        expect(result.toolCall).toBe(true);
        expect(result.structuredOutput).toBe(true);
        expect(await connections.selectRole(manager, probe, AbortSignal.timeout(20_000))).toEqual(
          result,
        );
        const consumption = await database.client<
          {
            purpose: string;
            model: string;
            count: number;
            input: string;
            output: string;
          }[]
        >`SELECT operation.purpose,operation.model,count(*)::int AS count,
          sum((entry.counters->>'input')::bigint)::text AS input,
          sum((entry.counters->>'output')::bigint)::text AS output
          FROM factory.usage_operation operation JOIN factory.usage_entry entry ON entry.operation_id=operation.id
          WHERE operation.user_id=${manager} AND operation.model=${connection.modelId}
          GROUP BY operation.purpose,operation.model`;
        expect(consumption).toHaveLength(1);
        expect(consumption[0]?.purpose).toBe("probe");
        expect(Number(consumption[0]?.input) + Number(consumption[0]?.output)).toBeGreaterThan(0);
        expect((await connections.resolve(saved.connectionID, saved.version)).apiKey).toBe(
          connection.apiKey,
        );
      }
      expect(
        (await connections.roles(manager)).every(
          (role) => role.active && role.check?.result?.status === "ready",
        ),
      ).toBe(true);
      expect(await database.client`SELECT id FROM factory.project`).toHaveLength(0);
      const persisted =
        JSON.stringify(
          await database.client`SELECT row_to_json(row) FROM factory.model_connection_write row`,
        ) +
        JSON.stringify(
          await database.client`SELECT row_to_json(row) FROM factory.model_connection_version row`,
        ) +
        JSON.stringify(
          await database.client`SELECT row_to_json(row) FROM factory.model_role_probe row`,
        );
      for (const connection of deploymentModelConnections(signingKey))
        if (connection.apiKey) expect(persisted).not.toContain(connection.apiKey);
      expect(
        JSON.parse(await readFile(join(bao.directory, "bootstrap.json"), "utf8")).root_token,
      ).toBe("");
    } finally {
      await database.client.end({ timeout: 2 });
      await factory.dispose();
      await bao.dispose();
      await rm(directory, { recursive: true });
    }
  },
  90_000,
);
