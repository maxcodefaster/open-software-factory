import { expect, test } from "bun:test";
import type postgres from "postgres";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { codingReasoningIn, createModelSettingsController } from "./controller";

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
    reasoning?: string | null;
    connection?: boolean;
    manager?: boolean;
  } = {},
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
                      JSON.stringify(rules),
                    ],
                  ];
          else if (query.includes('from "factory"."project_model_settings"'))
            rows =
              options.projectVersion === undefined
                ? []
                : [
                    [
                      options.projectVersion,
                      JSON.stringify(projectRule),
                      JSON.stringify(projectRule),
                    ],
                  ];
          else if (query.includes('from "factory"."personal_model_settings"'))
            rows =
              options.personalVersion === undefined
                ? []
                : [[options.personalVersion, null, "alternative-model"]];
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
    controller: createModelSettingsController(database, environment),
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
