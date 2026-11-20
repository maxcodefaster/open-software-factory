import { and, sql as drizzleSQL, eq } from "drizzle-orm";
import type { z } from "zod";
import { modelProvider } from "../../../../packages/conversation-domain/src/model-connection";
import {
  type InheritedModelSettingsView,
  type ModelRole,
  modelRoles,
  type PersonalModelSettings,
  type ProjectModelSettings,
  personalModelInput,
  projectModelInput,
  resolveRoleModel,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import {
  approvedModelCatalogue,
  codingReasoningInput,
  type ModelSettingsView,
  type modelDefaultsInput,
  modelRulesInput,
} from "../../../../packages/conversation-domain/src/model-settings";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  administrator,
  modelConnectionVersion,
  modelDefaults,
  modelRoleConnection,
  personalModelSettings,
  projectModelSettings,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { providerCatalogue } from "./native";

export async function codingReasoningIn(sql: AgentTurnTransaction) {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtext('factory-model-settings'))`;
  const [stored] = await drizzleTransaction(sql)
    .select({
      reasoning: drizzleSQL<string | null>`${modelDefaults.roleRules}->'build'->>'reasoningEffort'`,
    })
    .from(modelDefaults)
    .where(eq(modelDefaults.singleton, true));
  return codingReasoningInput.parse(stored?.reasoning ?? "medium");
}

export function modelEnvironment() {
  const planningModelId =
    process.env["FACTORY_PROJECT_AGENT_MODEL"]?.trim() || "factory-planning-model";
  const buildModelId = process.env["FACTORY_AGENT_MODEL_ID"]?.trim() || "factory-coding-model";
  return {
    planningModelId,
    buildModelId,
    models: approvedModelCatalogue({
      planningModelId,
      buildModelId,
      additionalIds: process.env["FACTORY_MODEL_IDS"],
    }),
    baseURL: process.env["FACTORY_MODEL_BASE_URL"]?.trim() || undefined,
    apiKey: process.env["FACTORY_MODEL_API_KEY"]?.trim() || undefined,
  };
}

export function createModelSettingsController(
  database: ReturnType<typeof createDatabase>,
  environment = modelEnvironment(),
) {
  const { baseURL, apiKey } = environment;
  const emptyProject: ProjectModelSettings = {
    version: 0,
    planning: { modelId: null, models: null, allowOverride: null },
    build: { modelId: null, models: null, allowOverride: null },
  };
  async function lock(sql: AgentTurnTransaction, write = false) {
    if (write) await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
    else await sql`SELECT pg_advisory_xact_lock_shared(hashtext('factory-model-settings'))`;
  }
  async function get(
    client: AgentTurnTransaction | typeof database.client = database.client,
  ): Promise<ModelSettingsView> {
    const db = client === database.client ? database.db : drizzleTransaction(client);
    const connections = await db
      .select({
        role: modelRoleConnection.role,
        provider: modelConnectionVersion.provider,
        modelId: modelRoleConnection.modelId,
        endpoint: modelConnectionVersion.endpoint,
      })
      .from(modelRoleConnection)
      .innerJoin(
        modelConnectionVersion,
        and(
          eq(modelConnectionVersion.connectionId, modelRoleConnection.connectionId),
          eq(modelConnectionVersion.version, modelRoleConnection.connectionVersion),
        ),
      );
    const catalogue = await providerCatalogue();
    const models = [
      ...new Set([
        ...environment.models,
        ...connections.flatMap((binding) => [
          binding.modelId,
          ...(catalogue.find((entry) => entry.provider === binding.provider)?.models ?? []),
        ]),
      ]),
    ];
    function permitted(role: ModelRole) {
      const binding = connections.find((entry) => entry.role === role);
      return binding
        ? [
            ...new Set([
              binding.modelId,
              ...(catalogue.find((entry) => entry.provider === binding.provider)?.models ?? []),
            ]),
          ]
        : environment.models;
    }
    const [stored] = await db
      .select({
        version: modelDefaults.version,
        planningModelId: modelDefaults.planningModelId,
        buildModelId: modelDefaults.buildModelId,
        rules: modelDefaults.roleRules,
      })
      .from(modelDefaults)
      .where(eq(modelDefaults.singleton, true));
    const rules = modelRulesInput.parse(
      stored?.rules ?? {
        planning: { models: permitted("planning"), allowOverride: true },
        build: { models: permitted("build"), allowOverride: true },
      },
    );
    for (const binding of connections)
      rules[binding.role].models = rules[binding.role].models.filter((id) =>
        permitted(binding.role).includes(id),
      );
    return {
      ...(stored ?? {
        version: 0,
        planningModelId:
          connections.find((binding) => binding.role === "planning")?.modelId ??
          environment.planningModelId,
        buildModelId:
          connections.find((binding) => binding.role === "build")?.modelId ??
          environment.buildModelId,
      }),
      source: stored ? "administrator" : "environment",
      rules,
      models,
      connection: {
        configured: Boolean(connections.length || (baseURL && apiKey)),
        buildProvider: modelProvider.parse(
          connections.find((entry) => entry.role === "build")?.provider ??
            process.env["FACTORY_MODEL_PROVIDER"] ??
            "openai",
        ),
        host: connections[0]
          ? new URL(connections[0].endpoint).host
          : baseURL
            ? new URL(baseURL).host
            : null,
      },
    };
  }
  async function inherited(
    sql: AgentTurnTransaction,
    projectID: string,
    userID: string,
    personalSelection = true,
  ): Promise<InheritedModelSettingsView> {
    const canManageProject = await projectAuthorityIn(sql, userID, projectID);
    const system = await get(sql);
    const db = drizzleTransaction(sql);
    const [projectRow] = await db
      .select({
        version: projectModelSettings.version,
        planning: projectModelSettings.planning,
        build: projectModelSettings.build,
      })
      .from(projectModelSettings)
      .where(eq(projectModelSettings.projectId, projectID));
    const project = projectRow ? projectModelInput.parse(projectRow) : emptyProject;
    const [personalRow] = personalSelection
      ? await db
          .select({
            version: personalModelSettings.version,
            planningModelId: personalModelSettings.planningModelId,
            buildModelId: personalModelSettings.buildModelId,
          })
          .from(personalModelSettings)
          .where(
            and(
              eq(personalModelSettings.projectId, projectID),
              eq(personalModelSettings.userId, userID),
            ),
          )
      : [];
    const personal = personalRow
      ? personalModelInput.parse(personalRow)
      : { version: 0, planningModelId: null, buildModelId: null };
    const resolve = (role: ModelRole, personalSelection = true) =>
      resolveRoleModel({
        systemModelId: role === "planning" ? system.planningModelId : system.buildModelId,
        systemRule: system.rules[role],
        catalogue: system.models,
        project: project[role],
        personalModelId: personalSelection
          ? role === "planning"
            ? personal.planningModelId
            : personal.buildModelId
          : null,
      });
    return {
      system,
      project,
      personal,
      effective: { planning: resolve("planning"), build: resolve("build") },
      projectEffective: { planning: resolve("planning", false), build: resolve("build", false) },
      canManageProject,
    };
  }
  function changedElsewhere() {
    return new CommandError("conflict", "Model settings changed elsewhere. Reload before saving.");
  }
  return {
    get,
    async getInherited(projectID: string, userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql);
        return inherited(sql, projectID, userID);
      });
    },
    async resolve(
      role: ModelRole,
      sql: AgentTurnTransaction,
      context: { projectID: string; userID: string; personal?: boolean },
    ) {
      await lock(sql);
      const view = await inherited(
        sql,
        context.projectID,
        context.userID,
        context.personal !== false,
      );
      const effective = (context.personal === false ? view.projectEffective : view.effective)[role];
      if (!effective.available)
        throw new CommandError(
          "unavailable",
          "The effective model is no longer approved. Ask a manager to update model settings.",
        );
      return effective.modelId;
    },
    async setProject(projectID: string, userID: string, value: ProjectModelSettings) {
      const input = projectModelInput.parse(value);
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        await projectAuthorityIn(sql, userID, projectID, true);
        const db = drizzleTransaction(sql);
        const system = await get(sql);
        for (const role of modelRoles) {
          const rule = input[role];
          const parent = system.rules[role];
          const defaultId = role === "planning" ? system.planningModelId : system.buildModelId;
          if (rule.models?.some((id) => !parent.models.includes(id) || !system.models.includes(id)))
            throw new CommandError(
              "conflict",
              "Project rules cannot widen the approved System models",
            );
          if (
            !parent.allowOverride &&
            (rule.allowOverride === true || (rule.modelId !== null && rule.modelId !== defaultId))
          )
            throw new CommandError("conflict", "Project rules cannot unlock a System restriction");
          if (
            !(rule.models ?? parent.models).includes(rule.modelId ?? defaultId) ||
            !system.models.includes(rule.modelId ?? defaultId)
          )
            throw new CommandError(
              "conflict",
              "The Project default must be an approved permitted model",
            );
        }
        const [changed] =
          input.version === 0
            ? await db
                .insert(projectModelSettings)
                .values({
                  projectId: projectID,
                  version: 1,
                  planning: input.planning,
                  build: input.build,
                  updatedBy: userID,
                })
                .onConflictDoNothing()
                .returning({ version: projectModelSettings.version })
            : await db
                .update(projectModelSettings)
                .set({
                  version: drizzleSQL`${projectModelSettings.version} + 1`,
                  planning: input.planning,
                  build: input.build,
                  updatedBy: userID,
                  updatedAt: drizzleSQL`now()`,
                })
                .where(
                  and(
                    eq(projectModelSettings.projectId, projectID),
                    eq(projectModelSettings.version, input.version),
                  ),
                )
                .returning({ version: projectModelSettings.version });
        if (!changed) throw changedElsewhere();
        return inherited(sql, projectID, userID);
      });
    },
    async setPersonal(projectID: string, userID: string, value: PersonalModelSettings) {
      const input = personalModelInput.parse(value);
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        const db = drizzleTransaction(sql);
        const current = await inherited(sql, projectID, userID);
        for (const role of modelRoles) {
          const id = role === "planning" ? input.planningModelId : input.buildModelId;
          if (
            id !== null &&
            (!current.effective[role].allowOverride || !current.effective[role].models.includes(id))
          )
            throw new CommandError(
              "conflict",
              "Personal selection is locked or not approved by the current rules",
            );
        }
        const [changed] =
          input.version === 0
            ? await db
                .insert(personalModelSettings)
                .values({
                  projectId: projectID,
                  userId: userID,
                  version: 1,
                  planningModelId: input.planningModelId,
                  buildModelId: input.buildModelId,
                })
                .onConflictDoNothing()
                .returning({ version: personalModelSettings.version })
            : await db
                .update(personalModelSettings)
                .set({
                  version: drizzleSQL`${personalModelSettings.version} + 1`,
                  planningModelId: input.planningModelId,
                  buildModelId: input.buildModelId,
                  updatedAt: drizzleSQL`now()`,
                })
                .where(
                  and(
                    eq(personalModelSettings.projectId, projectID),
                    eq(personalModelSettings.userId, userID),
                    eq(personalModelSettings.version, input.version),
                  ),
                )
                .returning({ version: personalModelSettings.version });
        if (!changed) throw changedElsewhere();
        return inherited(sql, projectID, userID);
      });
    },
    async set(input: z.input<typeof modelDefaultsInput>, userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        const db = drizzleTransaction(sql);
        const [manager] = await db
          .select({ userId: administrator.userId })
          .from(administrator)
          .where(eq(administrator.userId, userID))
          .for("share");
        if (!manager) throw new CommandError("forbidden", "System Manager access required");
        const current = await get(sql);
        const models = current.models;
        if (!models.includes(input.planningModelId) || !models.includes(input.buildModelId))
          throw new CommandError("conflict", "Choose a model from the approved catalogue");
        const rules = modelRulesInput.parse(input.rules ?? current.rules);
        for (const role of modelRoles) {
          const id = role === "planning" ? input.planningModelId : input.buildModelId;
          if (
            rules[role].models.some((id) => !models.includes(id)) ||
            !rules[role].models.includes(id)
          )
            throw new CommandError(
              "conflict",
              "System defaults must use approved permitted models",
            );
        }
        const [changed] =
          input.version === 0
            ? await db
                .insert(modelDefaults)
                .values({
                  singleton: true,
                  version: 1,
                  planningModelId: input.planningModelId,
                  buildModelId: input.buildModelId,
                  roleRules: rules,
                  updatedBy: userID,
                })
                .onConflictDoNothing()
                .returning({ version: modelDefaults.version })
            : await db
                .update(modelDefaults)
                .set({
                  version: drizzleSQL`${modelDefaults.version} + 1`,
                  planningModelId: input.planningModelId,
                  buildModelId: input.buildModelId,
                  roleRules: rules,
                  updatedBy: userID,
                  updatedAt: drizzleSQL`now()`,
                })
                .where(
                  and(eq(modelDefaults.singleton, true), eq(modelDefaults.version, input.version)),
                )
                .returning({ version: modelDefaults.version });
        if (!changed)
          throw new CommandError(
            "conflict",
            "Model settings changed elsewhere. Reload before saving.",
          );
        return get(sql);
      });
    },
  };
}
