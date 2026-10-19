import type { z } from "zod";
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
  type ModelSettingsView,
  type modelDefaultsInput,
  modelRulesInput,
  codingReasoningInput,
} from "../../../../packages/conversation-domain/src/model-settings";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { providerCatalogue } from "./native";

export async function codingReasoningIn(sql: AgentTurnTransaction) {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtext('factory-model-settings'))`;
  const [stored] = await sql<Array<{ reasoning: string | null }>>`
    SELECT role_rules->'build'->>'reasoningEffort' AS reasoning
    FROM factory.model_defaults WHERE singleton`;
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
  type Defaults = Pick<ModelSettingsView, "version" | "planningModelId" | "buildModelId"> & {
    rules: ModelSettingsView["rules"] | null;
  };
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
    sql: AgentTurnTransaction | typeof database.client = database.client,
  ): Promise<ModelSettingsView> {
    const connections = await sql<
      Array<{ role: ModelRole; provider: string; modelId: string; endpoint: string }>
    >`
      SELECT binding.role, version.provider, binding.model_id AS "modelId", version.endpoint FROM factory.model_role_connection binding
      JOIN factory.model_connection_version version ON version.connection_id=binding.connection_id AND version.version=binding.connection_version`;
    const catalogue = providerCatalogue();
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
    const [stored] = await sql<Defaults[]>`
      SELECT version::float8 AS version, planning_model_id AS "planningModelId",
        build_model_id AS "buildModelId", role_rules AS rules FROM factory.model_defaults WHERE singleton
    `;
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
  ): Promise<InheritedModelSettingsView> {
    const canManageProject = await projectAuthorityIn(sql, userID, projectID);
    const system = await get(sql);
    const [projectRow] = await sql<ProjectModelSettings[]>`
      SELECT version::float8 AS version, planning, build FROM factory.project_model_settings WHERE project_id = ${projectID}
    `;
    const project = projectRow ? projectModelInput.parse(projectRow) : emptyProject;
    const [personalRow] = await sql<PersonalModelSettings[]>`
      SELECT version::float8 AS version, planning_model_id AS "planningModelId", build_model_id AS "buildModelId"
      FROM factory.personal_model_settings WHERE project_id = ${projectID} AND user_id = ${userID}
    `;
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
      context: { projectID: string; userID: string },
    ) {
      await lock(sql);
      const view = await inherited(sql, context.projectID, context.userID);
      const effective = view.effective[role];
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
            ? await sql`
          INSERT INTO factory.project_model_settings(project_id, version, planning, build, updated_by)
          VALUES (${projectID}, 1, ${JSON.stringify(input.planning)}::jsonb, ${JSON.stringify(input.build)}::jsonb, ${userID})
          ON CONFLICT DO NOTHING
          RETURNING version
        `
            : await sql`
          UPDATE factory.project_model_settings SET version = version + 1,
            planning = ${JSON.stringify(input.planning)}::jsonb, build = ${JSON.stringify(input.build)}::jsonb, updated_by = ${userID}, updated_at = now()
          WHERE project_id = ${projectID} AND version = ${input.version} RETURNING version
        `;
        if (!changed) throw changedElsewhere();
        return inherited(sql, projectID, userID);
      });
    },
    async setPersonal(projectID: string, userID: string, value: PersonalModelSettings) {
      const input = personalModelInput.parse(value);
      return database.client.begin(async (sql) => {
        await lock(sql, true);
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
            ? await sql`
          INSERT INTO factory.personal_model_settings(project_id, user_id, version, planning_model_id, build_model_id)
          VALUES (${projectID}, ${userID}, 1, ${input.planningModelId}, ${input.buildModelId})
          ON CONFLICT DO NOTHING RETURNING version
        `
            : await sql`
          UPDATE factory.personal_model_settings SET version = version + 1,
            planning_model_id = ${input.planningModelId}, build_model_id = ${input.buildModelId}, updated_at = now()
          WHERE project_id = ${projectID} AND user_id = ${userID} AND version = ${input.version} RETURNING version
        `;
        if (!changed) throw changedElsewhere();
        return inherited(sql, projectID, userID);
      });
    },
    async set(input: z.input<typeof modelDefaultsInput>, userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        const [administrator] =
          await sql`SELECT user_id FROM factory.administrator WHERE user_id = ${userID} FOR SHARE`;
        if (!administrator) throw new CommandError("forbidden", "System Manager access required");
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
            ? await sql<Array<{ version: number }>>`
              INSERT INTO factory.model_defaults(singleton, version, planning_model_id, build_model_id, role_rules, updated_by)
              VALUES (true, 1, ${input.planningModelId}, ${input.buildModelId}, ${JSON.stringify(rules)}::jsonb, ${userID})
              ON CONFLICT DO NOTHING RETURNING version
            `
            : await sql<Array<{ version: number }>>`
              UPDATE factory.model_defaults SET version = version + 1,
                planning_model_id = ${input.planningModelId}, build_model_id = ${input.buildModelId},
                role_rules = ${JSON.stringify(rules)}::jsonb,
                updated_by = ${userID}, updated_at = now()
              WHERE singleton AND version = ${input.version} RETURNING version
            `;
        if (!changed)
          throw new CommandError(
            "conflict",
            "Model settings changed elsewhere. Reload before saving.",
          );
        return get(sql);
      });
    },
    async checkConnection() {
      if (!baseURL || !apiKey) return { status: "unconfigured" as const };
      try {
        const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
          redirect: "error",
        });
        await response.body?.cancel();
        return { status: response.ok ? ("reachable" as const) : ("unavailable" as const) };
      } catch {
        return { status: "unavailable" as const };
      }
    },
  };
}
