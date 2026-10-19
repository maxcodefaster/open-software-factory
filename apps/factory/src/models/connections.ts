import { createHmac } from "node:crypto";
import {
  modelConnectionWrite,
  type ModelConnectionWrite,
  type ModelConnectionView,
  type ModelProvider,
  type ModelConnectionReference,
} from "../../../../packages/conversation-domain/src/model-connection";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { validateModelEndpoint, type ResolvedModelConnection } from "./native";
import type { ModelSecrets, StoredModelConnection } from "./secrets";
import { probeModel } from "./probe";
import { modelRoleConnectionInput } from "../../../../packages/conversation-domain/src/model-connection";
import type { z } from "zod";
import {
  modelProbeResult,
  modelRoleConnectionView,
  type ModelProbeResult,
} from "../../../../packages/conversation-domain/src/model-connection";
import { codingReasoningIn, createModelSettingsController, modelEnvironment } from "./controller";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import { deploymentModelConnections } from "./deployment";
import { recordedMastraUsage } from "../usage/record-mastra";
import { createUsageJournal } from "../usage/journal";
import { unknownCounters } from "../../../../packages/conversation-domain/src/usage";

type Intent = {
  commandID: string;
  connectionID: string;
  baseVersion: number;
  provider: ModelProvider;
  endpoint: string;
  fingerprint: string;
  secretKey: string;
  state: "write-intended" | "committed";
  createdBy: string;
};
type Version = { version: number; provider: ModelProvider; endpoint: string; secretKey: string };

export function createModelConnections(
  database: ReturnType<typeof createDatabase>,
  secrets: ModelSecrets,
  signingKey: string,
  allowedOrigins: readonly string[] = [],
  probe = probeModel,
) {
  const endpointOrigins = [
    ...new Set([
      ...allowedOrigins,
      ...deploymentModelConnections(signingKey).flatMap((value) =>
        value.configured && value.endpoint ? [new URL(value.endpoint).origin] : [],
      ),
    ]),
  ];
  const conflict = () =>
    new CommandError(
      "conflict",
      "Model connection changed or a save is pending. Reload or retry the same save.",
    );
  async function manager(sql: AgentTurnTransaction, userID: string) {
    const [row] =
      await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userID} FOR SHARE`;
    if (!row) throw new CommandError("forbidden", "System Manager access required");
  }
  async function lock(sql: AgentTurnTransaction, id: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`model-connection:${id}`}))`;
  }
  async function current(sql: AgentTurnTransaction, id: string) {
    const [row] = await sql<
      Version[]
    >`SELECT version::float8 AS version, provider, endpoint, secret_key AS "secretKey"
      FROM factory.model_connection_version WHERE connection_id=${id} ORDER BY version DESC LIMIT 1`;
    return row;
  }
  async function intent(sql: AgentTurnTransaction, commandID: string) {
    const [row] = await sql<
      Intent[]
    >`SELECT command_id AS "commandID", connection_id AS "connectionID",
      base_version::float8 AS "baseVersion", provider, endpoint, fingerprint, secret_key AS "secretKey", state, created_by AS "createdBy"
      FROM factory.model_connection_write WHERE command_id=${commandID}`;
    return row;
  }
  async function settle(row: Intent, stored: StoredModelConnection) {
    if (
      stored.commandID !== row.commandID ||
      stored.connectionID !== row.connectionID ||
      stored.fingerprint !== row.fingerprint ||
      stored.provider !== row.provider ||
      stored.endpoint !== row.endpoint
    )
      throw new CommandError(
        "unavailable",
        "Stored model connection does not match its save intent",
      );
    await database.client.begin(async (sql) => {
      await lock(sql, row.connectionID);
      await manager(sql, row.createdBy);
      const latest = await intent(sql, row.commandID);
      if (latest?.state === "committed") return;
      if (!latest || ((await current(sql, row.connectionID))?.version ?? 0) !== row.baseVersion)
        throw conflict();
      await sql`INSERT INTO factory.model_connection_version(connection_id, version, provider, endpoint, secret_key, created_by)
        VALUES (${row.connectionID}, ${row.baseVersion + 1}, ${row.provider}, ${row.endpoint}, ${row.secretKey}, ${row.createdBy})`;
      await sql`UPDATE factory.model_connection_write SET state='committed', committed_at=now() WHERE command_id=${row.commandID}`;
    });
  }
  async function get(connectionID: string, userID: string): Promise<ModelConnectionView> {
    return database.client.begin(async (sql) => {
      await manager(sql, userID);
      const row = await current(sql, connectionID);
      const [pending] = await sql<
        Array<{ commandID: string; provider: ModelProvider; endpoint: string }>
      >`
        SELECT command_id AS "commandID", provider, endpoint FROM factory.model_connection_write
        WHERE connection_id=${connectionID} AND state='write-intended'`;
      const metadata = row ?? pending;
      if (!metadata) throw new CommandError("not-found", "Model connection not found");
      return {
        connectionID,
        version: row?.version ?? 0,
        provider: metadata.provider,
        endpoint: metadata.endpoint,
        configured: Boolean(row),
        pendingCommandID: pending?.commandID ?? null,
      };
    });
  }
  async function resolve(connectionID: string, version: number): Promise<ResolvedModelConnection> {
    const [row] = await database.client<
      Array<Version & { commandID: string; fingerprint: string }>
    >`SELECT version.version::float8 AS version, version.provider, version.endpoint, version.secret_key AS "secretKey",
      intent.command_id AS "commandID", intent.fingerprint
      FROM factory.model_connection_version version JOIN factory.model_connection_write intent ON intent.secret_key=version.secret_key
      WHERE version.connection_id=${connectionID} AND version.version=${version}`;
    if (!row) throw new CommandError("unavailable", "The admitted model connection is unavailable");
    validateModelEndpoint({ provider: row.provider, endpoint: row.endpoint }, endpointOrigins);
    const stored = await secrets.read(row.secretKey);
    if (
      !stored ||
      stored.connectionID !== connectionID ||
      stored.provider !== row.provider ||
      stored.endpoint !== row.endpoint ||
      stored.commandID !== row.commandID ||
      stored.fingerprint !== row.fingerprint
    )
      throw new CommandError("unavailable", "The admitted model credential is unavailable");
    return { provider: stored.provider, baseURL: row.endpoint, apiKey: stored.apiKey };
  }
  return {
    get,
    resolve,
    async roles(userID: string) {
      return database.client.begin(async (sql) => {
        await manager(sql, userID);
        const result = [];
        for (const role of ["planning", "build"] as const) {
          const [active] = await sql`SELECT connection_id AS "connectionID",
            connection_version::float8 AS version, model_id AS "modelId"
            FROM factory.model_role_connection WHERE role=${role}`;
          const [check] = await sql`SELECT command_id AS "commandID", state, result
            FROM factory.model_role_probe WHERE role=${role} ORDER BY created_at DESC, command_id DESC LIMIT 1`;
          result.push(
            modelRoleConnectionView.parse({ role, active: active ?? null, check: check ?? null }),
          );
        }
        return result;
      });
    },
    async selectRole(
      userID: string,
      value: z.output<typeof modelRoleConnectionInput>,
      signal: AbortSignal,
    ) {
      const input = modelRoleConnectionInput.parse(value);
      let reasoningEffort: CodingReasoning = "medium";
      const admitted = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
        await manager(sql, userID);
        const [previous] = await sql<
          Array<{
            state: string;
            result: unknown;
            connectionID: string;
            version: number;
            modelId: string;
            role: string;
            settingsVersion: number;
            createdBy: string;
            reasoningEffort: CodingReasoning | null;
          }>
        >`
          SELECT state, result, connection_id AS "connectionID", connection_version::float8 AS version, model_id AS "modelId", role,
            settings_version::float8 AS "settingsVersion", created_by AS "createdBy",
            reasoning_effort AS "reasoningEffort" FROM factory.model_role_probe WHERE command_id=${input.commandID}`;
        if (previous) {
          if (
            previous.createdBy !== userID ||
            previous.connectionID !== input.connectionID ||
            previous.version !== input.version ||
            previous.modelId !== input.modelId ||
            previous.role !== input.role ||
            previous.settingsVersion !== input.settingsVersion ||
            previous.reasoningEffort !== (input.reasoningEffort ?? null)
          )
            throw conflict();
          if (previous.state === "probing")
            throw new CommandError(
              "conflict",
              "This check is already admitted. Observe its result; do not send another paid check.",
            );
          return modelProbeResult.parse(previous.result);
        }
        const [defaults] = await sql<
          Array<{ version: number }>
        >`SELECT version::float8 AS version FROM factory.model_defaults WHERE singleton`;
        if ((defaults?.version ?? 0) !== input.settingsVersion) throw conflict();
        if (input.role === "build")
          reasoningEffort = input.reasoningEffort ?? (await codingReasoningIn(sql));
        const selected = await current(sql, input.connectionID);
        if (selected?.version !== input.version) throw conflict();
        if (input.reasoningEffort && selected.provider !== "openai")
          throw new CommandError(
            "conflict",
            "Reasoning selection is available for OpenAI Coding models only.",
          );
        await sql`INSERT INTO factory.model_role_probe(command_id, role, connection_id, connection_version, model_id, settings_version, created_by, state, reasoning_effort)
          VALUES (${input.commandID}, ${input.role}, ${input.connectionID}, ${input.version}, ${input.modelId}, ${input.settingsVersion}, ${userID}, 'probing', ${input.reasoningEffort ?? null})`;
        return undefined;
      });
      if (admitted) return admitted;
      const connection = await resolve(input.connectionID, input.version);
      const result = await probe({
        connection,
        modelId: input.modelId,
        signal,
        role: input.role,
        ...(input.role === "build" ? { reasoningEffort } : {}),
        usageSink: recordedMastraUsage(database, {
          engine: input.role === "build" ? "opencode" : "mastra",
          id: `probe:${input.commandID}`,
          projectID: null,
          userID,
          provider: connection.provider ?? "openai",
          model: input.modelId,
          purpose: "probe",
        }),
      });
      await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
        await lock(sql, input.connectionID);
        await manager(sql, userID);
        const [probe] =
          await sql`SELECT command_id FROM factory.model_role_probe WHERE command_id=${input.commandID} AND state='probing' FOR UPDATE`;
        if (!probe) return;
        const [defaults] = await sql<
          Array<{
            version: number;
            rules: { planning: { models: string[] }; build: { models: string[] } } | null;
          }>
        >`
          SELECT version::float8 AS version, role_rules AS rules FROM factory.model_defaults WHERE singleton FOR UPDATE`;
        if (
          result.status === "ready" &&
          ((defaults?.version ?? 0) !== input.settingsVersion ||
            (await current(sql, input.connectionID))?.version !== input.version)
        )
          result.status = "superseded";
        await sql`UPDATE factory.model_role_probe SET state='finished', result=${JSON.stringify(result)}::jsonb, finished_at=now() WHERE command_id=${input.commandID}`;
        if (result.status !== "ready") return;
        await sql`INSERT INTO factory.model_role_connection(role, connection_id, connection_version, model_id, updated_by)
          VALUES (${input.role}, ${input.connectionID}, ${input.version}, ${input.modelId}, ${userID})
          ON CONFLICT (role) DO UPDATE SET connection_id=EXCLUDED.connection_id, connection_version=EXCLUDED.connection_version,
            model_id=EXCLUDED.model_id, updated_by=EXCLUDED.updated_by, updated_at=now()`;
        if (defaults) {
          const column = input.role === "planning" ? "planning_model_id" : "build_model_id";
          const { rules } = await createModelSettingsController(database).get(sql);
          rules[input.role].models = [...new Set([...rules[input.role].models, input.modelId])];
          if (input.role === "build") rules.build.reasoningEffort = reasoningEffort;
          await sql`UPDATE factory.model_defaults SET ${sql(column)}=${input.modelId}, role_rules=${JSON.stringify(rules)}::jsonb, version=version+1, updated_by=${userID}, updated_at=now() WHERE singleton`;
        } else {
          const environment = modelEnvironment();
          const { rules } = await createModelSettingsController(database).get(sql);
          rules[input.role].models = [...new Set([...rules[input.role].models, input.modelId])];
          if (input.role === "build") rules.build.reasoningEffort = reasoningEffort;
          await sql`INSERT INTO factory.model_defaults(singleton, version, planning_model_id, build_model_id, updated_by, role_rules)
            VALUES (true, 1, ${input.role === "planning" ? input.modelId : environment.planningModelId},
              ${input.role === "build" ? input.modelId : environment.buildModelId}, ${userID}, ${JSON.stringify(rules)}::jsonb)`;
        }
      });
      return result;
    },
    async reference(
      role: "planning" | "build",
      sql: AgentTurnTransaction,
    ): Promise<ModelConnectionReference | undefined> {
      const [row] = await sql<
        Array<ModelConnectionReference>
      >`SELECT connection_id AS "connectionID", connection_version::float8 AS version FROM factory.model_role_connection WHERE role=${role}`;
      return row;
    },
    async list(userID: string) {
      const ids = await database.client.begin(async (sql) => {
        await manager(sql, userID);
        return sql<
          Array<{ id: string }>
        >`SELECT DISTINCT connection_id AS id FROM factory.model_connection_write ORDER BY id`;
      });
      return Promise.all(ids.map(({ id }) => get(id, userID)));
    },
    async save(userID: string, value: ModelConnectionWrite) {
      const input = modelConnectionWrite.parse(value);
      const endpoint = validateModelEndpoint(input, endpointOrigins);
      const fingerprint = createHmac("sha256", signingKey)
        .update(JSON.stringify({ ...input, endpoint }))
        .digest("hex");
      const row = await database.client.begin(async (sql) => {
        await lock(sql, input.connectionID);
        await manager(sql, userID);
        if (!secrets.configured)
          throw new CommandError(
            "unavailable",
            "Connect OpenBao before saving provider credentials",
          );
        const previous = await intent(sql, input.commandID);
        if (previous) {
          if (
            previous.fingerprint !== fingerprint ||
            previous.createdBy !== userID ||
            previous.connectionID !== input.connectionID
          )
            throw conflict();
          return previous;
        }
        const active = await current(sql, input.connectionID);
        if ((active?.version ?? 0) !== input.version) throw conflict();
        if (active && active.provider !== input.provider)
          throw new CommandError(
            "conflict",
            "Create a separate connection for a different provider",
          );
        const [pending] =
          await sql`SELECT command_id FROM factory.model_connection_write WHERE connection_id=${input.connectionID} AND state='write-intended'`;
        if (pending) throw conflict();
        const next: Intent = {
          commandID: input.commandID,
          connectionID: input.connectionID,
          baseVersion: input.version,
          provider: input.provider,
          endpoint,
          fingerprint,
          secretKey: `models/${input.connectionID}/${input.commandID}`,
          state: "write-intended",
          createdBy: userID,
        };
        await sql`INSERT INTO factory.model_connection_write(command_id, connection_id, base_version, provider, endpoint, fingerprint, secret_key, created_by)
          VALUES (${next.commandID}, ${next.connectionID}, ${next.baseVersion}, ${next.provider}, ${endpoint}, ${fingerprint}, ${next.secretKey}, ${userID})`;
        return next;
      });
      if (row.state === "committed") return get(input.connectionID, userID);
      let stored = await secrets.read(row.secretKey);
      if (!stored) {
        const candidate: StoredModelConnection = {
          commandID: row.commandID,
          connectionID: row.connectionID,
          provider: row.provider,
          endpoint: row.endpoint,
          fingerprint: row.fingerprint,
          apiKey: input.apiKey,
        };
        try {
          await secrets.create(row.secretKey, candidate);
          stored = candidate;
        } catch {
          stored = await secrets.read(row.secretKey);
          if (!stored)
            throw new CommandError(
              "unavailable",
              "Model save is unconfirmed. Retry the same save; current settings remain active.",
            );
        }
      }
      await settle(row, stored);
      return get(input.connectionID, userID);
    },
    async recover() {
      const interrupted: ModelProbeResult = {
        status: "unavailable",
        modelId: "unconfirmed",
        toolCall: false,
        structuredOutput: false,
        limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
      };
      const abandoned = await database.client<
        Array<{ command_id: string }>
      >`UPDATE factory.model_role_probe SET state='uncertain', result=jsonb_set(${JSON.stringify(interrupted)}::jsonb, '{modelId}', to_jsonb(model_id)), finished_at=now()
        WHERE state='probing' AND created_at < now() - interval '30 seconds' RETURNING command_id`;
      const journal = createUsageJournal(database);
      for (const probe of abandoned) {
        const id = `probe:${probe.command_id}`;
        const [operation] = await database.client<
          Array<{ created_at: Date }>
        >`SELECT created_at FROM factory.usage_operation WHERE id=${id} AND settled_at IS NULL`;
        if (operation) {
          await journal.record(id, {
            eventID: "unobserved",
            source: "unobserved",
            outcome: "unknown",
            counters: unknownCounters(),
            occurredAt: new Date(operation.created_at).toISOString(),
          });
          await journal.settle(id, "unknown");
        }
      }
      if (!secrets.configured) return;
      const rows = await database.client<
        Array<{ commandID: string }>
      >`SELECT command_id AS "commandID" FROM factory.model_connection_write WHERE state='write-intended' ORDER BY created_at LIMIT 32`;
      for (const { commandID } of rows) {
        const row = await database.client.begin((sql) => intent(sql, commandID));
        if (row?.state !== "write-intended") continue;
        const stored = await secrets.read(row.secretKey);
        if (stored) await settle(row, stored);
      }
    },
  };
}
