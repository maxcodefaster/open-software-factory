import { and, eq, sql as expression, isNull, lt } from "drizzle-orm";
import type { z } from "zod";
import {
  type ModelProbeResult,
  modelProbeResult,
  modelRoleConnectionInput,
} from "#conversation-domain/model-connection";
import type { CodingReasoning } from "#conversation-domain/model-settings";
import { unknownCounters } from "#conversation-domain/usage";
import { drizzleTransaction } from "#db/client";
import { modelSettings, operation as operationTable, usageOperation } from "#db/schema";
import { CommandError } from "../command-error";
import { createUsageJournal } from "../usage/journal-api";
import { recordedMastraUsage } from "../usage/record-mastra";
import {
  CONNECTION_SCOPE_TYPE,
  connectionConflict,
  lockConnection,
  type ModelsDatabase,
  readCurrentConnectionVersion,
  requireSystemManager,
} from "./connection-writes";
import { codingReasoningIn, createModelSettingsController, modelEnvironment } from "./controller";
import type { ResolvedModelConnection } from "./inference-contracts";
import type { probeModel } from "./probe";

export const MODEL_ROLE_PROBE_KIND = "models.role_probe";
const roleProbeIdempotencyKey = (commandID: string) => `${MODEL_ROLE_PROBE_KIND}:${commandID}`;

export type RoleProbePhase = "probing" | "finished" | "uncertain";

export const ROLE_PROBE_TRANSITIONS: Record<RoleProbePhase, readonly RoleProbePhase[]> = {
  probing: ["finished", "uncertain"],
  finished: [],
  uncertain: [],
};

export function canTransitionRoleProbe(from: RoleProbePhase, to: RoleProbePhase): boolean {
  return ROLE_PROBE_TRANSITIONS[from].includes(to);
}

export type RoleProbePayload = {
  role: "planning" | "build";
  connectionID: string;
  connectionVersion: number;
  modelId: string;
  settingsVersion: number;
  reasoningEffort: CodingReasoning | null;
};

type RoleSelectionInput = z.output<typeof modelRoleConnectionInput>;

async function admitRoleProbe(
  database: ModelsDatabase,
  userID: string,
  input: RoleSelectionInput,
): Promise<{ result: ModelProbeResult } | { reasoningEffort: CodingReasoning }> {
  let reasoningEffort: CodingReasoning = "medium";
  const replayed = await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
    await requireSystemManager(sql, userID);
    const [previous] = await db
      .select({
        state: operationTable.state,
        result: operationTable.result,
        createdBy: operationTable.createdBy,
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(
        and(eq(operationTable.id, input.commandID), eq(operationTable.kind, MODEL_ROLE_PROBE_KIND)),
      );
    if (previous) {
      const payload = previous.payload as RoleProbePayload;
      if (
        previous.createdBy !== userID ||
        payload.connectionID !== input.connectionID ||
        Number(payload.connectionVersion) !== input.version ||
        payload.modelId !== input.modelId ||
        payload.role !== input.role ||
        Number(payload.settingsVersion) !== input.settingsVersion ||
        (payload.reasoningEffort ?? null) !== (input.reasoningEffort ?? null)
      )
        throw connectionConflict();
      if (previous.state === "probing")
        throw new CommandError(
          "conflict",
          "This check is already admitted. Observe its result; do not send another paid check.",
        );
      return modelProbeResult.parse(previous.result);
    }
    const [defaults] = await db
      .select({ version: modelSettings.version })
      .from(modelSettings)
      .where(and(eq(modelSettings.scopeType, "default"), eq(modelSettings.scopeKey, "default")));
    if ((defaults?.version ?? 0) !== input.settingsVersion) throw connectionConflict();
    if (input.role === "build")
      reasoningEffort = input.reasoningEffort ?? (await codingReasoningIn(sql));
    const selected = await readCurrentConnectionVersion(sql, input.connectionID);
    if (selected?.version !== input.version) throw connectionConflict();
    if (input.reasoningEffort && selected.provider !== "openai")
      throw new CommandError(
        "conflict",
        "Reasoning selection is available for OpenAI Coding models only.",
      );
    const [maintenance] = await db
      .select({ state: operationTable.state })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, "installation.maintenance"),
          eq(operationTable.idempotencyKey, "installation.maintenance:singleton"),
        ),
      )
      .for("share");
    if (!maintenance) throw new Error("Installation maintenance state is unavailable");
    if (maintenance.state === "enabled")
      throw new CommandError("unavailable", "Factory is in maintenance; new work was not admitted");
    await db.insert(operationTable).values({
      id: input.commandID,
      kind: MODEL_ROLE_PROBE_KIND,
      scopeType: CONNECTION_SCOPE_TYPE,
      scopeId: input.connectionID,
      idempotencyKey: roleProbeIdempotencyKey(input.commandID),
      activeKey: null,
      state: "probing",
      payload: {
        role: input.role,
        connectionID: input.connectionID,
        connectionVersion: input.version,
        modelId: input.modelId,
        settingsVersion: input.settingsVersion,
        reasoningEffort: input.reasoningEffort ?? null,
      },
      result: null,
      error: null,
      createdBy: userID,
      completedAt: null,
    });
    return undefined;
  });
  return replayed ? { result: replayed } : { reasoningEffort };
}

async function settleRoleProbe(params: {
  database: ModelsDatabase;
  userID: string;
  input: RoleSelectionInput;
  reasoningEffort: CodingReasoning;
  result: ModelProbeResult;
}): Promise<void> {
  const { database, userID, input, reasoningEffort, result } = params;
  await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
    await lockConnection(sql, input.connectionID);
    await requireSystemManager(sql, userID);
    const [probe] = await db
      .select({ commandID: operationTable.id, state: operationTable.state })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.id, input.commandID),
          eq(operationTable.kind, MODEL_ROLE_PROBE_KIND),
          eq(operationTable.state, "probing"),
        ),
      )
      .for("update");
    if (!probe || !canTransitionRoleProbe(probe.state as RoleProbePhase, "finished")) return;
    const [defaults] = await db
      .select({ version: modelSettings.version, settings: modelSettings.settings })
      .from(modelSettings)
      .where(and(eq(modelSettings.scopeType, "default"), eq(modelSettings.scopeKey, "default")))
      .for("update");
    if (
      result.status === "ready" &&
      ((defaults?.version ?? 0) !== input.settingsVersion ||
        (await readCurrentConnectionVersion(sql, input.connectionID))?.version !== input.version)
    )
      result.status = "superseded";
    await db
      .update(operationTable)
      .set({
        state: "finished",
        result,
        updatedAt: expression`now()`,
        completedAt: expression`now()`,
      })
      .where(
        and(
          eq(operationTable.id, input.commandID),
          eq(operationTable.kind, MODEL_ROLE_PROBE_KIND),
          eq(operationTable.state, "probing"),
        ),
      );
    if (result.status !== "ready") return;
    await db
      .insert(modelSettings)
      .values({
        scopeType: "role_connection",
        scopeKey: input.role,
        version: 1,
        connectionId: input.connectionID,
        connectionVersion: input.version,
        settings: { modelId: input.modelId },
        updatedBy: userID,
      })
      .onConflictDoUpdate({
        target: [modelSettings.scopeType, modelSettings.scopeKey],
        set: {
          connectionId: input.connectionID,
          connectionVersion: input.version,
          settings: { modelId: input.modelId },
          version: expression`${modelSettings.version} + 1`,
          updatedBy: userID,
          updatedAt: expression`now()`,
        },
      });
    const { rules } = await createModelSettingsController(database).get(sql);
    rules[input.role].models = [...new Set([...rules[input.role].models, input.modelId])];
    if (input.role === "build") rules.build.reasoningEffort = reasoningEffort;
    if (defaults) {
      const field = input.role === "planning" ? "planningModelId" : "buildModelId";
      await db
        .update(modelSettings)
        .set({
          settings: { ...defaults.settings, [field]: input.modelId, roleRules: rules },
          version: expression`${modelSettings.version}+1`,
          updatedBy: userID,
          updatedAt: expression`now()`,
        })
        .where(and(eq(modelSettings.scopeType, "default"), eq(modelSettings.scopeKey, "default")));
    } else {
      const environment = modelEnvironment();
      await db.insert(modelSettings).values({
        scopeType: "default",
        scopeKey: "default",
        version: 1,
        settings: {
          planningModelId: input.role === "planning" ? input.modelId : environment.planningModelId,
          buildModelId: input.role === "build" ? input.modelId : environment.buildModelId,
          roleRules: rules,
        },
        updatedBy: userID,
      });
    }
  });
}

export async function selectModelRole(params: {
  database: ModelsDatabase;
  resolve: (connectionID: string, version: number) => Promise<ResolvedModelConnection>;
  probe: typeof probeModel;
  userID: string;
  value: RoleSelectionInput;
  signal: AbortSignal;
}): Promise<ModelProbeResult> {
  const { database, resolve, probe, userID, value, signal } = params;
  const input = modelRoleConnectionInput.parse(value);
  const admitted = await admitRoleProbe(database, userID, input);
  if ("result" in admitted) return admitted.result;
  const connection = await resolve(input.connectionID, input.version);
  const result = await probe({
    connection,
    modelId: input.modelId,
    signal,
    role: input.role,
    ...(input.role === "build" ? { reasoningEffort: admitted.reasoningEffort } : {}),
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
  await settleRoleProbe({
    database,
    userID,
    input,
    reasoningEffort: admitted.reasoningEffort,
    result,
  });
  return result;
}

export async function recoverAbandonedRoleProbes(database: ModelsDatabase): Promise<void> {
  const interrupted: ModelProbeResult = {
    status: "unavailable",
    modelId: "unconfirmed",
    toolCall: false,
    structuredOutput: false,
    limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
  };
  const abandoned = await database.db
    .update(operationTable)
    .set({
      state: "uncertain",
      result: expression`jsonb_set(${JSON.stringify(interrupted)}::jsonb, '{modelId}', COALESCE(${operationTable.payload}->'modelId', to_jsonb('unconfirmed'::text)))`,
      updatedAt: expression`now()`,
      completedAt: expression`now()`,
    })
    .where(
      and(
        eq(operationTable.kind, MODEL_ROLE_PROBE_KIND),
        eq(operationTable.state, "probing"),
        lt(operationTable.createdAt, expression`now() - interval '30 seconds'`),
      ),
    )
    .returning({ commandID: operationTable.id });
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
}
