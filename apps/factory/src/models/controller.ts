import { and, sql as drizzleSQL, eq } from "drizzle-orm";
import type { z } from "zod";
import { modelProvider } from "#conversation-domain/model-connection";
import {
  type InheritedModelSettingsView,
  type ModelRole,
  modelRoles,
  type PersonalModelSettings,
  type ProjectModelSettings,
  personalModelInput,
  projectModelInput,
  resolveRoleModel,
} from "#conversation-domain/model-inheritance";
import {
  approvedModelCatalogue,
  codingReasoningInput,
  type ModelSettingsView,
  type modelDefaultsInput,
  modelRulesInput,
} from "#conversation-domain/model-settings";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { administrator, modelConnectionVersion, modelSettings } from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { providerCatalogue } from "./native";

const DEFAULT_SCOPE_KEY = "default";
const personalScopeKey = (projectID: string, userID: string) => `${projectID}:${userID}`;

type DefaultModelSettingsPayload = {
  planningModelId: string;
  buildModelId: string;
  roleRules?: unknown;
};

export async function codingReasoningIn(sql: DatabaseTransaction) {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtext('factory-model-settings'))`;
  const [stored] = await drizzleTransaction(sql)
    .select({
      reasoning: drizzleSQL<
        string | null
      >`${modelSettings.settings}->'roleRules'->'build'->>'reasoningEffort'`,
    })
    .from(modelSettings)
    .where(
      and(eq(modelSettings.scopeType, "default"), eq(modelSettings.scopeKey, DEFAULT_SCOPE_KEY)),
    );
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
  async function lock(sql: DatabaseTransaction, write = false) {
    if (write) await sql`SELECT pg_advisory_xact_lock(hashtext('factory-model-settings'))`;
    else await sql`SELECT pg_advisory_xact_lock_shared(hashtext('factory-model-settings'))`;
  }
  async function get(
    client: DatabaseTransaction | typeof database.client = database.client,
  ): Promise<ModelSettingsView> {
    const db = client === database.client ? database.db : drizzleTransaction(client);
    const connections = await db
      .select({
        role: modelSettings.scopeKey,
        provider: modelConnectionVersion.provider,
        modelId: drizzleSQL<string>`${modelSettings.settings}->>'modelId'`,
        endpoint: modelConnectionVersion.endpoint,
      })
      .from(modelSettings)
      .innerJoin(
        modelConnectionVersion,
        and(
          eq(modelConnectionVersion.connectionId, modelSettings.connectionId),
          eq(modelConnectionVersion.version, modelSettings.connectionVersion),
        ),
      )
      .where(eq(modelSettings.scopeType, "role_connection"));
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
    const [storedRow] = await db
      .select({
        version: modelSettings.version,
        settings: modelSettings.settings,
      })
      .from(modelSettings)
      .where(
        and(eq(modelSettings.scopeType, "default"), eq(modelSettings.scopeKey, DEFAULT_SCOPE_KEY)),
      );
    const storedSettings = storedRow?.settings as DefaultModelSettingsPayload | undefined;
    const stored =
      storedRow && storedSettings
        ? {
            version: storedRow.version,
            planningModelId: storedSettings.planningModelId,
            buildModelId: storedSettings.buildModelId,
            rules: storedSettings.roleRules ?? null,
          }
        : undefined;
    const rules = modelRulesInput.parse(
      stored?.rules ?? {
        planning: { models: permitted("planning"), allowOverride: true },
        build: { models: permitted("build"), allowOverride: true },
      },
    );
    for (const binding of connections) {
      const role = binding.role as ModelRole;
      rules[role].models = rules[role].models.filter((id) => permitted(role).includes(id));
    }
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
    sql: DatabaseTransaction,
    projectID: string,
    userID: string,
    personalSelection = true,
  ): Promise<InheritedModelSettingsView> {
    const canManageProject = await projectAuthorityIn(sql, userID, projectID);
    const system = await get(sql);
    const db = drizzleTransaction(sql);
    const [projectRow] = await db
      .select({
        version: modelSettings.version,
        settings: modelSettings.settings,
      })
      .from(modelSettings)
      .where(and(eq(modelSettings.scopeType, "project"), eq(modelSettings.scopeKey, projectID)));
    const project = projectRow
      ? projectModelInput.parse({
          version: projectRow.version,
          planning: projectRow.settings["planning"],
          build: projectRow.settings["build"],
        })
      : emptyProject;
    const [personalRow] = personalSelection
      ? await db
          .select({
            version: modelSettings.version,
            settings: modelSettings.settings,
          })
          .from(modelSettings)
          .where(
            and(
              eq(modelSettings.scopeType, "personal"),
              eq(modelSettings.scopeKey, personalScopeKey(projectID, userID)),
            ),
          )
      : [];
    const personal = personalRow
      ? personalModelInput.parse({
          version: personalRow.version,
          planningModelId: personalRow.settings["planningModelId"] ?? null,
          buildModelId: personalRow.settings["buildModelId"] ?? null,
        })
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
      sql: DatabaseTransaction,
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
                .insert(modelSettings)
                .values({
                  scopeType: "project",
                  scopeKey: projectID,
                  projectId: projectID,
                  version: 1,
                  settings: { planning: input.planning, build: input.build },
                  updatedBy: userID,
                })
                .onConflictDoNothing()
                .returning({ version: modelSettings.version })
            : await db
                .update(modelSettings)
                .set({
                  version: drizzleSQL`${modelSettings.version} + 1`,
                  settings: { planning: input.planning, build: input.build },
                  updatedBy: userID,
                  updatedAt: drizzleSQL`now()`,
                })
                .where(
                  and(
                    eq(modelSettings.scopeType, "project"),
                    eq(modelSettings.scopeKey, projectID),
                    eq(modelSettings.version, input.version),
                  ),
                )
                .returning({ version: modelSettings.version });
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
                .insert(modelSettings)
                .values({
                  scopeType: "personal",
                  scopeKey: personalScopeKey(projectID, userID),
                  projectId: projectID,
                  userId: userID,
                  version: 1,
                  settings: {
                    planningModelId: input.planningModelId,
                    buildModelId: input.buildModelId,
                  },
                })
                .onConflictDoNothing()
                .returning({ version: modelSettings.version })
            : await db
                .update(modelSettings)
                .set({
                  version: drizzleSQL`${modelSettings.version} + 1`,
                  settings: {
                    planningModelId: input.planningModelId,
                    buildModelId: input.buildModelId,
                  },
                  updatedAt: drizzleSQL`now()`,
                })
                .where(
                  and(
                    eq(modelSettings.scopeType, "personal"),
                    eq(modelSettings.scopeKey, personalScopeKey(projectID, userID)),
                    eq(modelSettings.version, input.version),
                  ),
                )
                .returning({ version: modelSettings.version });
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
                .insert(modelSettings)
                .values({
                  scopeType: "default",
                  scopeKey: DEFAULT_SCOPE_KEY,
                  version: 1,
                  settings: {
                    planningModelId: input.planningModelId,
                    buildModelId: input.buildModelId,
                    roleRules: rules,
                  },
                  updatedBy: userID,
                })
                .onConflictDoNothing()
                .returning({ version: modelSettings.version })
            : await db
                .update(modelSettings)
                .set({
                  version: drizzleSQL`${modelSettings.version} + 1`,
                  settings: {
                    planningModelId: input.planningModelId,
                    buildModelId: input.buildModelId,
                    roleRules: rules,
                  },
                  updatedBy: userID,
                  updatedAt: drizzleSQL`now()`,
                })
                .where(
                  and(
                    eq(modelSettings.scopeType, "default"),
                    eq(modelSettings.scopeKey, DEFAULT_SCOPE_KEY),
                    eq(modelSettings.version, input.version),
                  ),
                )
                .returning({ version: modelSettings.version });
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
