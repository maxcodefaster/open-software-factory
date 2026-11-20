import { expect, test } from "bun:test";
import type postgres from "postgres";
import type {
  PersonalModelSettings,
  ProjectModelSettings,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import type { ModelSettingsView } from "../../../../packages/conversation-domain/src/model-settings";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  codingReasoningIn,
  createModelSettingsController,
  type modelEnvironment,
} from "./controller";

const userID = "01994a7d-0000-7000-8000-000000000001";
const projectID = "01994a7d-0000-7000-8000-000000000002";
const environment = {
  planningModelId: "planning-model",
  buildModelId: "build-model",
  models: ["planning-model", "build-model", "alternative-model"],
  baseURL: undefined,
  apiKey: undefined,
};
const rules = {
  planning: { models: environment.models, allowOverride: true },
  build: { models: environment.models, allowOverride: true, reasoningEffort: "high" as const },
};
const projectRule = { modelId: null, models: null, allowOverride: null };

function fixture(
  options: {
    version?: string;
    projectVersion?: string;
    personalVersion?: string;
    projectRules?: Pick<ProjectModelSettings, "planning" | "build">;
    personalModels?: Pick<PersonalModelSettings, "planningModelId" | "buildModelId">;
    roleRules?: ModelSettingsView["rules"];
    reasoning?: string | null;
    connection?: boolean;
    manager?: boolean;
  } = {},
  configuration: ReturnType<typeof modelEnvironment> = environment,
) {
  const queries: Array<{ query: string; parameters: unknown[]; transaction: number }> = [];
  let transactions = 0;
  function connection(transaction: number) {
    return Object.assign(
      async (parts: TemplateStringsArray) => {
        const query = parts.join("?");
        queries.push({ query, parameters: [], transaction });
        if (!query.includes("pg_advisory_xact_lock")) throw new Error(`Unexpected SQL: ${query}`);
        return [];
      },
      {
        unsafe(query: string, parameters: unknown[]) {
          queries.push({ query, parameters, transaction });
          let rows: unknown[][];
          if (query.startsWith("insert into") || query.startsWith("update ")) rows = [];
          else if (query.includes('from "auth"."user"')) rows = [[userID]];
          else if (query.includes('from "factory"."account_access"')) rows = [[null, null]];
          else if (query.includes('from "factory"."administrator"'))
            rows = options.manager === false ? [] : [[userID]];
          else if (query.includes('from "factory"."project_membership"'))
            rows = [["developer", true]];
          else if (query.includes('from "factory"."project"')) rows = [[projectID]];
          else if (query.includes('from "factory"."model_role_connection"'))
            rows = options.connection
              ? [["build", "openai", "alternative-model", "https://models.factory.test/v1"]]
              : [];
          else if (query.includes("'reasoningEffort'")) rows = [[options.reasoning ?? null]];
          else if (query.includes('from "factory"."model_defaults"'))
            rows =
              options.version === undefined
                ? []
                : [
                    [
                      options.version,
                      environment.planningModelId,
                      environment.buildModelId,
                      JSON.stringify(options.roleRules ?? rules),
                    ],
                  ];
          else if (query.includes('from "factory"."project_model_settings"'))
            rows =
              options.projectVersion === undefined
                ? []
                : [
                    [
                      options.projectVersion,
                      JSON.stringify(options.projectRules?.planning ?? projectRule),
                      JSON.stringify(options.projectRules?.build ?? projectRule),
                    ],
                  ];
          else if (query.includes('from "factory"."personal_model_settings"'))
            rows =
              options.personalVersion === undefined || parameters[1] !== userID
                ? []
                : [
                    [
                      options.personalVersion,
                      options.personalModels?.planningModelId ?? null,
                      options.personalModels
                        ? options.personalModels.buildModelId
                        : "alternative-model",
                    ],
                  ];
          else throw new Error(`Unexpected query: ${query}`);
          return { values: async () => rows };
        },
      },
    );
  }
  const client = Object.assign(connection(0), {
    begin: async <T>(operation: (sql: postgres.TransactionSql) => Promise<T>) =>
      operation(connection(++transactions) as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  const database = { client, db: drizzleTransaction(client) } as ReturnType<typeof createDatabase>;
  return {
    controller: createModelSettingsController(database, configuration),
    transaction: connection(1) as unknown as postgres.TransactionSql,
    queries,
  };
}

test("unpersisted model settings keep environment defaults on standalone typed reads", async () => {
  const f = fixture();
  expect(await f.controller.get()).toMatchObject({
    version: 0,
    source: "environment",
    planningModelId: environment.planningModelId,
    buildModelId: environment.buildModelId,
    rules: { build: { reasoningEffort: "medium" } },
  });
  expect(f.queries).toHaveLength(2);
  expect(f.queries.every(({ transaction }) => transaction === 0)).toBe(true);
});

test("settings expose installation connection status and host without credentials or key storage", async () => {
  const f = fixture(
    {},
    {
      ...environment,
      baseURL: "https://models.factory.test/v1",
      apiKey: "owned-private-credential",
    },
  );
  const view = await f.controller.getInherited(projectID, userID);
  expect(view.system.connection).toMatchObject({ configured: true, host: "models.factory.test" });
  expect(JSON.stringify(view)).not.toContain("owned-private-credential");
  expect(JSON.stringify(view)).not.toContain("apiKey");
  expect(f.queries.some(({ query }) => query.includes("secret_key"))).toBe(false);
  expect(
    f.queries.some(({ query }) => query.startsWith("insert into") || query.startsWith("update ")),
  ).toBe(false);
});

test("inherited settings decode bigint and JSON values within the caller's shared lock", async () => {
  const version = String(Number.MAX_SAFE_INTEGER);
  const f = fixture({ version, projectVersion: version, personalVersion: version });
  const view = await f.controller.getInherited(projectID, userID);
  expect(view.system.version).toBe(Number.MAX_SAFE_INTEGER);
  expect(view.project.version).toBe(Number.MAX_SAFE_INTEGER);
  expect(view.personal.version).toBe(Number.MAX_SAFE_INTEGER);
  expect(view.system.rules).toEqual(rules);
  expect(view.effective.build.modelId).toBe("alternative-model");
  expect(view.projectEffective.build.modelId).toBe(environment.buildModelId);
  expect(f.queries[0]?.query).toContain("pg_advisory_xact_lock_shared");
  expect(f.queries.every(({ transaction }) => transaction === 1)).toBe(true);
  const personalRead = f.queries.find(({ query }) =>
    query.includes('from "factory"."personal_model_settings"'),
  );
  expect(personalRead?.parameters).toEqual([projectID, userID]);
});

test("missing inherited rows keep reset defaults instead of inventing saved versions", async () => {
  const view = await fixture().controller.getInherited(projectID, userID);
  expect(view.project).toEqual({ version: 0, planning: projectRule, build: projectRule });
  expect(view.personal).toEqual({ version: 0, planningModelId: null, buildModelId: null });
  expect(view.effective.build.modelId).toBe(environment.buildModelId);
});

const projectDefaults = {
  planning: { ...projectRule, modelId: "alternative-model" },
  build: { ...projectRule, modelId: "alternative-model" },
};
const personalModels = { planningModelId: "build-model", buildModelId: "planning-model" };

test.each(["planning", "build"] as const)(
  "%s resolution retains installation, Project and personal precedence",
  async (role) => {
    const installationModel =
      role === "planning" ? environment.planningModelId : environment.buildModelId;
    const f = fixture();
    expect(await f.controller.resolve(role, f.transaction, { projectID, userID })).toBe(
      installationModel,
    );
    const project = fixture({ projectVersion: "1", projectRules: projectDefaults });
    expect(await project.controller.resolve(role, project.transaction, { projectID, userID })).toBe(
      "alternative-model",
    );
    const personal = fixture({
      projectVersion: "1",
      projectRules: projectDefaults,
      personalVersion: "1",
      personalModels,
    });
    expect(
      await personal.controller.resolve(role, personal.transaction, { projectID, userID }),
    ).toBe(role === "planning" ? personalModels.planningModelId : personalModels.buildModelId);
    expect(personal.queries[0]?.query).toContain("pg_advisory_xact_lock_shared");
    expect(personal.queries.every(({ transaction }) => transaction === 1)).toBe(true);
  },
);

test.each(["planning", "build"] as const)(
  "background %s resolution does not read even malformed personal settings",
  async (role) => {
    for (const projectVersion of [undefined, "1"]) {
      const f = fixture({
        ...(projectVersion ? { projectVersion } : {}),
        projectRules: projectDefaults,
        personalVersion: "invalid-personal-version",
        personalModels,
      });
      expect(
        await f.controller.resolve(role, f.transaction, { projectID, userID, personal: false }),
      ).toBe(
        projectVersion
          ? "alternative-model"
          : role === "planning"
            ? environment.planningModelId
            : environment.buildModelId,
      );
      expect(
        f.queries.some(({ query }) => query.includes('from "factory"."personal_model_settings"')),
      ).toBe(false);
      expect(f.queries.every(({ transaction }) => transaction === 1)).toBe(true);
    }
  },
);

test.each(["planning", "build"] as const)(
  "saved null %s selections reset to Project and installation defaults",
  async (role) => {
    for (const projectRules of [projectDefaults, { planning: projectRule, build: projectRule }]) {
      const f = fixture({
        projectVersion: "1",
        projectRules,
        personalVersion: "1",
        personalModels: { planningModelId: null, buildModelId: null },
      });
      expect(await f.controller.resolve(role, f.transaction, { projectID, userID })).toBe(
        projectRules[role].modelId ??
          (role === "planning" ? environment.planningModelId : environment.buildModelId),
      );
    }
  },
);

test("personal settings stay scoped to the requesting user and never enter another viewer's result", async () => {
  const f = fixture({
    projectVersion: "1",
    projectRules: projectDefaults,
    personalVersion: "1",
    personalModels,
  });
  const otherUserID = "01994a7d-0000-7000-8000-000000000003";
  const view = await f.controller.getInherited(projectID, otherUserID);
  expect(view.personal).toEqual({ version: 0, planningModelId: null, buildModelId: null });
  expect(view.effective.planning).toMatchObject({
    modelId: "alternative-model",
    source: "project",
  });
  expect(view.effective.build).toMatchObject({ modelId: "alternative-model", source: "project" });
  expect(
    f.queries.find(({ query }) => query.includes('from "factory"."personal_model_settings"'))
      ?.parameters,
  ).toEqual([projectID, otherUserID]);
});

test.each(["system", "project"] as const)(
  "disabled %s overrides ignore saved lower-scope selections for both roles",
  async (scope) => {
    const f = fixture({
      version: "1",
      roleRules: {
        planning: { ...rules.planning, allowOverride: scope !== "system" },
        build: { ...rules.build, allowOverride: scope !== "system" },
      },
      projectVersion: "1",
      projectRules: {
        planning: { ...projectDefaults.planning, allowOverride: false },
        build: { ...projectDefaults.build, allowOverride: false },
      },
      personalVersion: "1",
      personalModels,
    });
    const view = await f.controller.getInherited(projectID, userID);
    for (const role of ["planning", "build"] as const) {
      const modelId =
        scope === "project"
          ? "alternative-model"
          : role === "planning"
            ? environment.planningModelId
            : environment.buildModelId;
      expect(view.effective[role]).toMatchObject({
        modelId,
        source: scope,
        allowOverride: false,
        lockedReason: scope === "system" ? "Locked by System Manager" : "Locked by Project Manager",
        available: true,
      });
      for (const personal of [true, false])
        expect(
          await f.controller.resolve(role, f.transaction, { projectID, userID, personal }),
        ).toBe(modelId);
    }
  },
);

test.each(["planning", "build"] as const)(
  "%s resolution rejects withdrawn defaults and empty permitted intersections",
  async (role) => {
    for (const projectModels of [null, ["alternative-model"]]) {
      const f = fixture({
        version: "1",
        roleRules: {
          planning: { models: [environment.buildModelId], allowOverride: false },
          build: {
            models: [environment.planningModelId],
            allowOverride: false,
            reasoningEffort: "high",
          },
        },
        projectVersion: "1",
        projectRules: {
          planning: { ...projectRule, models: projectModels },
          build: { ...projectRule, models: projectModels },
        },
        personalVersion: "1",
        personalModels,
      });
      for (const personal of [true, false])
        await expect(
          f.controller.resolve(role, f.transaction, { projectID, userID, personal }),
        ).rejects.toMatchObject({
          code: "unavailable",
          status: 503,
          message:
            "The effective model is no longer approved. Ask a manager to update model settings.",
        });
      expect(
        f.queries.some(
          ({ query }) => query.startsWith("insert into") || query.startsWith("update "),
        ),
      ).toBe(false);
    }
  },
);

test("model bindings join the exact immutable connection version and keep public metadata", async () => {
  const f = fixture({ connection: true });
  const view = await f.controller.get();
  expect(view.buildModelId).toBe("alternative-model");
  expect(view.models).toContain("alternative-model");
  expect(view.connection).toEqual({
    configured: true,
    buildProvider: "openai",
    host: "models.factory.test",
  });
  expect(f.queries[0]?.query).toContain('inner join "factory"."model_connection_version"');
  expect(f.queries[0]?.query).toContain(
    '"factory"."model_connection_version"."connection_id" = "factory"."model_role_connection"."connection_id"',
  );
  expect(f.queries[0]?.query).toContain(
    '"factory"."model_connection_version"."version" = "factory"."model_role_connection"."connection_version"',
  );
  expect(f.queries[0]?.query).not.toContain("secret_key");
});

test.each([
  { reasoning: null, expected: "medium" },
  { reasoning: "max", expected: "max" },
])("coding reasoning retains the stored value and fallback for $reasoning", async (input) => {
  const f = fixture(input);
  expect(await codingReasoningIn(f.transaction)).toBe(input.expected);
  expect(f.queries[0]?.query).toContain("pg_advisory_xact_lock_shared");
  expect(f.queries[1]?.query).toContain("\"role_rules\"->'build'->>'reasoningEffort'");
  expect(f.queries.every(({ transaction }) => transaction === 1)).toBe(true);
});

test("invalid stored coding reasoning is rejected rather than treated as a default", async () => {
  const f = fixture({ reasoning: "none" });
  await expect(codingReasoningIn(f.transaction)).rejects.toThrow();
});

test.each(
  (["system", "project", "personal"] as const).flatMap((scope) =>
    [0, 13].map((version) => ({ scope, version })),
  ),
)("$scope settings version $version require a returned CAS row", async ({ scope, version }) => {
  const f = fixture({ version: "13", projectVersion: "13", personalVersion: "13" });
  const save =
    scope === "system"
      ? f.controller.set(
          {
            version,
            planningModelId: environment.planningModelId,
            buildModelId: environment.buildModelId,
          },
          userID,
        )
      : scope === "project"
        ? f.controller.setProject(projectID, userID, {
            version,
            planning: projectRule,
            build: projectRule,
          })
        : f.controller.setPersonal(projectID, userID, {
            version,
            planningModelId: null,
            buildModelId: null,
          });
  await expect(save).rejects.toMatchObject({
    code: "conflict",
    message: "Model settings changed elsewhere. Reload before saving.",
  });
  const writes = f.queries.filter(
    ({ query }) => query.startsWith("insert into") || query.startsWith("update "),
  );
  expect(writes).toHaveLength(1);
  const write = writes[0];
  if (!write) throw new Error("Model settings write was not executed");
  expect(write.transaction).toBe(1);
  expect(f.queries.every(({ transaction }) => transaction === 1)).toBe(true);
  expect(f.queries[0]?.query).toContain("pg_advisory_xact_lock(");
  expect(write.query).toContain('returning "version"');
  if (version === 0) {
    expect(write.query).toContain("on conflict do nothing");
    expect(write.parameters).toContain(1);
  } else {
    expect(write.query).toContain('"version" + 1');
    expect(write.query).toContain('"updated_at" = now()');
    expect(write.parameters.at(-1)).toBe(version);
    if (scope === "system") expect(write.query).toContain('"model_defaults"."singleton" =');
    else {
      expect(write.query).toContain('"project_id" =');
      expect(write.parameters).toContain(projectID);
      if (scope === "personal") expect(write.query).toContain('"user_id" =');
    }
  }
  if (scope === "project")
    expect(write.parameters.filter((value) => value === JSON.stringify(projectRule))).toHaveLength(
      2,
    );
  if (scope === "system") expect(write.parameters).toContain(JSON.stringify(rules));
  expect(f.queries.at(-1)).toBe(write);
});

test("system saves retain the administrator row lock and reject missing authority", async () => {
  const f = fixture({ manager: false });
  await expect(
    f.controller.set(
      {
        version: 0,
        planningModelId: environment.planningModelId,
        buildModelId: environment.buildModelId,
      },
      userID,
    ),
  ).rejects.toMatchObject({ code: "forbidden", message: "System Manager access required" });
  expect(f.queries).toHaveLength(2);
  expect(f.queries[1]?.query).toContain('from "factory"."administrator"');
  expect(f.queries[1]?.query).toContain("for share");
});
