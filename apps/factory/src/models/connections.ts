import { createHmac } from "node:crypto";
import { and, asc, desc, eq, sql as expression, isNull, lt } from "drizzle-orm";
import type { z } from "zod";
import {
  type ModelConnectionReference,
  type ModelConnectionView,
  type ModelConnectionWrite,
  type ModelProbeResult,
  modelConnectionWrite,
  modelProbeResult,
  modelRoleConnectionInput,
  modelRoleConnectionView,
} from "../../../../packages/conversation-domain/src/model-connection";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import { unknownCounters } from "../../../../packages/conversation-domain/src/usage";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  administrator,
  modelConnectionWrite as connectionWrite,
  modelConnectionVersion,
  modelDefaults,
  modelRoleConnection,
  modelRoleProbe,
  usageOperation,
} from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";
import { createUsageJournal } from "../usage/journal-api";
import { recordedMastraUsage } from "../usage/record-mastra";
import { codingReasoningIn, createModelSettingsController, modelEnvironment } from "./controller";
import { deploymentModelConnections } from "./deployment";
import { type ResolvedModelConnection } from "./inference-contracts";
import { validateModelEndpoint } from "./native";
import { probeModel } from "./probe";
import type { ModelSecrets, StoredModelConnection } from "./secrets";

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
  async function manager(sql: DatabaseTransaction, userID: string) {
    const [row] = await drizzleTransaction(sql)
      .select({ userID: administrator.userId })
      .from(administrator)
      .where(eq(administrator.userId, userID))
      .for("share");
    if (!row) throw new CommandError("forbidden", "System Manager access required");
  }
  async function lock(sql: DatabaseTransaction, id: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`model-connection:${id}`}))`;
  }
  async function current(sql: DatabaseTransaction, id: string) {
    const [row] = await drizzleTransaction(sql)
      .select({
        version: modelConnectionVersion.version,
        provider: modelConnectionVersion.provider,
        endpoint: modelConnectionVersion.endpoint,
        secretKey: modelConnectionVersion.secretKey,
      })
      .from(modelConnectionVersion)
      .where(eq(modelConnectionVersion.connectionId, id))
      .orderBy(desc(modelConnectionVersion.version))
      .limit(1);
    return row;
  }
  async function intent(sql: DatabaseTransaction, commandID: string) {
    const [row] = await drizzleTransaction(sql)
      .select({
        commandID: connectionWrite.commandId,
        connectionID: connectionWrite.connectionId,
        baseVersion: connectionWrite.baseVersion,
        provider: connectionWrite.provider,
        endpoint: connectionWrite.endpoint,
        fingerprint: connectionWrite.fingerprint,
        secretKey: connectionWrite.secretKey,
        state: connectionWrite.state,
        createdBy: connectionWrite.createdBy,
      })
      .from(connectionWrite)
      .where(eq(connectionWrite.commandId, commandID));
    return row;
  }
  type Intent = NonNullable<Awaited<ReturnType<typeof intent>>>;
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
      const db = drizzleTransaction(sql);
      await lock(sql, row.connectionID);
      await manager(sql, row.createdBy);
      const latest = await intent(sql, row.commandID);
      if (latest?.state === "committed") return;
      if (!latest || ((await current(sql, row.connectionID))?.version ?? 0) !== row.baseVersion)
        throw conflict();
      await db.insert(modelConnectionVersion).values({
        connectionId: row.connectionID,
        version: row.baseVersion + 1,
        provider: row.provider,
        endpoint: row.endpoint,
        secretKey: row.secretKey,
        createdBy: row.createdBy,
      });
      await db
        .update(connectionWrite)
        .set({ state: "committed", committedAt: expression`now()` })
        .where(eq(connectionWrite.commandId, row.commandID));
    });
  }
  async function get(connectionID: string, userID: string): Promise<ModelConnectionView> {
    return database.client.begin(async (sql) => {
      await manager(sql, userID);
      const row = await current(sql, connectionID);
      const [pending] = await drizzleTransaction(sql)
        .select({
          commandID: connectionWrite.commandId,
          provider: connectionWrite.provider,
          endpoint: connectionWrite.endpoint,
        })
        .from(connectionWrite)
        .where(
          and(
            eq(connectionWrite.connectionId, connectionID),
            eq(connectionWrite.state, "write-intended"),
          ),
        );
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
    const [row] = await database.db
      .select({
        version: modelConnectionVersion.version,
        provider: modelConnectionVersion.provider,
        endpoint: modelConnectionVersion.endpoint,
        secretKey: modelConnectionVersion.secretKey,
        commandID: connectionWrite.commandId,
        fingerprint: connectionWrite.fingerprint,
      })
      .from(modelConnectionVersion)
      .innerJoin(connectionWrite, eq(connectionWrite.secretKey, modelConnectionVersion.secretKey))
      .where(
        and(
          eq(modelConnectionVersion.connectionId, connectionID),
          eq(modelConnectionVersion.version, version),
        ),
      );
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
        const db = drizzleTransaction(sql);
        await manager(sql, userID);
        const result = [];
        for (const role of ["planning", "build"] as const) {
          const [active] = await db
            .select({
              connectionID: modelRoleConnection.connectionId,
              version: modelRoleConnection.connectionVersion,
              modelId: modelRoleConnection.modelId,
            })
            .from(modelRoleConnection)
            .where(eq(modelRoleConnection.role, role));
          const [check] = await db
            .select({
              commandID: modelRoleProbe.commandId,
              state: modelRoleProbe.state,
              result: modelRoleProbe.result,
            })
            .from(modelRoleProbe)
            .where(eq(modelRoleProbe.role, role))
            .orderBy(desc(modelRoleProbe.createdAt), desc(modelRoleProbe.commandId))
            .limit(1);
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
        const db = drizzleTransaction(sql);
        await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
        await manager(sql, userID);
        const [previous] = await db
          .select({
            state: modelRoleProbe.state,
            result: modelRoleProbe.result,
            connectionID: modelRoleProbe.connectionId,
            version: modelRoleProbe.connectionVersion,
            modelId: modelRoleProbe.modelId,
            role: modelRoleProbe.role,
            settingsVersion: modelRoleProbe.settingsVersion,
            createdBy: modelRoleProbe.createdBy,
            reasoningEffort: modelRoleProbe.reasoningEffort,
          })
          .from(modelRoleProbe)
          .where(eq(modelRoleProbe.commandId, input.commandID));
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
        const [defaults] = await db
          .select({ version: modelDefaults.version })
          .from(modelDefaults)
          .where(eq(modelDefaults.singleton, true));
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
        await db.insert(modelRoleProbe).values({
          commandId: input.commandID,
          role: input.role,
          connectionId: input.connectionID,
          connectionVersion: input.version,
          modelId: input.modelId,
          settingsVersion: input.settingsVersion,
          createdBy: userID,
          state: "probing",
          reasoningEffort: input.reasoningEffort ?? null,
        });
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
        const db = drizzleTransaction(sql);
        await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
        await lock(sql, input.connectionID);
        await manager(sql, userID);
        const [probe] = await db
          .select({ commandID: modelRoleProbe.commandId })
          .from(modelRoleProbe)
          .where(
            and(eq(modelRoleProbe.commandId, input.commandID), eq(modelRoleProbe.state, "probing")),
          )
          .for("update");
        if (!probe) return;
        const [defaults] = await db
          .select({ version: modelDefaults.version, rules: modelDefaults.roleRules })
          .from(modelDefaults)
          .where(eq(modelDefaults.singleton, true))
          .for("update");
        if (
          result.status === "ready" &&
          ((defaults?.version ?? 0) !== input.settingsVersion ||
            (await current(sql, input.connectionID))?.version !== input.version)
        )
          result.status = "superseded";
        await db
          .update(modelRoleProbe)
          .set({ state: "finished", result, finishedAt: expression`now()` })
          .where(eq(modelRoleProbe.commandId, input.commandID));
        if (result.status !== "ready") return;
        await db
          .insert(modelRoleConnection)
          .values({
            role: input.role,
            connectionId: input.connectionID,
            connectionVersion: input.version,
            modelId: input.modelId,
            updatedBy: userID,
          })
          .onConflictDoUpdate({
            target: modelRoleConnection.role,
            set: {
              connectionId: input.connectionID,
              connectionVersion: input.version,
              modelId: input.modelId,
              updatedBy: userID,
              updatedAt: expression`now()`,
            },
          });
        if (defaults) {
          const column = input.role === "planning" ? "planningModelId" : "buildModelId";
          const { rules } = await createModelSettingsController(database).get(sql);
          rules[input.role].models = [...new Set([...rules[input.role].models, input.modelId])];
          if (input.role === "build") rules.build.reasoningEffort = reasoningEffort;
          await db
            .update(modelDefaults)
            .set({
              [column]: input.modelId,
              roleRules: rules,
              version: expression`${modelDefaults.version}+1`,
              updatedBy: userID,
              updatedAt: expression`now()`,
            })
            .where(eq(modelDefaults.singleton, true));
        } else {
          const environment = modelEnvironment();
          const { rules } = await createModelSettingsController(database).get(sql);
          rules[input.role].models = [...new Set([...rules[input.role].models, input.modelId])];
          if (input.role === "build") rules.build.reasoningEffort = reasoningEffort;
          await db.insert(modelDefaults).values({
            singleton: true,
            version: 1,
            planningModelId:
              input.role === "planning" ? input.modelId : environment.planningModelId,
            buildModelId: input.role === "build" ? input.modelId : environment.buildModelId,
            updatedBy: userID,
            roleRules: rules,
          });
        }
      });
      return result;
    },
    async reference(
      role: "planning" | "build",
      sql: DatabaseTransaction,
    ): Promise<ModelConnectionReference | undefined> {
      const [row] = await drizzleTransaction(sql)
        .select({
          connectionID: modelRoleConnection.connectionId,
          version: modelRoleConnection.connectionVersion,
        })
        .from(modelRoleConnection)
        .where(eq(modelRoleConnection.role, role));
      return row;
    },
    async list(userID: string) {
      const ids = await database.client.begin(async (sql) => {
        await manager(sql, userID);
        return drizzleTransaction(sql)
          .selectDistinct({ id: connectionWrite.connectionId })
          .from(connectionWrite)
          .orderBy(asc(connectionWrite.connectionId));
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
        const db = drizzleTransaction(sql);
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
        const [pending] = await db
          .select({ commandID: connectionWrite.commandId })
          .from(connectionWrite)
          .where(
            and(
              eq(connectionWrite.connectionId, input.connectionID),
              eq(connectionWrite.state, "write-intended"),
            ),
          );
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
        await db.insert(connectionWrite).values({
          commandId: next.commandID,
          connectionId: next.connectionID,
          baseVersion: next.baseVersion,
          provider: next.provider,
          endpoint,
          fingerprint,
          secretKey: next.secretKey,
          createdBy: userID,
        });
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
      const abandoned = await database.db
        .update(modelRoleProbe)
        .set({
          state: "uncertain",
          result: expression`jsonb_set(${JSON.stringify(interrupted)}::jsonb, '{modelId}', to_jsonb(${modelRoleProbe.modelId}))`,
          finishedAt: expression`now()`,
        })
        .where(
          and(
            eq(modelRoleProbe.state, "probing"),
            lt(modelRoleProbe.createdAt, expression`now() - interval '30 seconds'`),
          ),
        )
        .returning({ commandID: modelRoleProbe.commandId });
      const journal = createUsageJournal(database);
      for (const probe of abandoned) {
        const id = `probe:${probe.commandID}`;
        const [operation] = await database.db
          .select({ createdAt: usageOperation.createdAt })
          .from(usageOperation)
          .where(and(eq(usageOperation.id, id), isNull(usageOperation.settledAt)));
        if (operation) {
          await journal.record(id, {
            eventID: "unobserved",
            source: "unobserved",
            outcome: "unknown",
            counters: unknownCounters(),
            occurredAt: operation.createdAt.toISOString(),
          });
          await journal.settle(id, "unknown");
        }
      }
      if (!secrets.configured) return;
      const rows = await database.db
        .select({ commandID: connectionWrite.commandId })
        .from(connectionWrite)
        .where(eq(connectionWrite.state, "write-intended"))
        .orderBy(asc(connectionWrite.createdAt))
        .limit(32);
      for (const { commandID } of rows) {
        const row = await database.client.begin((sql) => intent(sql, commandID));
        if (row?.state !== "write-intended") continue;
        const stored = await secrets.read(row.secretKey);
        if (stored) await settle(row, stored);
      }
    },
  };
}
