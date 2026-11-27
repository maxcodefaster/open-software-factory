import { expect, test } from "bun:test";
import type postgres from "postgres";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { createProjectService } from "./service";

const userID = "01994a7d-0000-7000-8000-000000000001";
const projectID = "01994a7d-0000-7000-8000-000000000002";
const createdAt = "2026-11-20T09:15:00.000Z";
const input = {
  slug: "typed-project",
  name: "Typed Project",
  repositoryUrl: "https://forge.test/factory/typed-project.git",
  defaultBranch: "main",
  actorTemplatePath: ".factory/actor-template.json",
};
const projectRow = [
  projectID,
  input.slug,
  input.name,
  "moonlit-landscape",
  input.repositoryUrl,
  input.defaultBranch,
  input.actorTemplatePath,
  createdAt,
];

function fixture(
  projectRows: unknown[][] = [projectRow],
  failure?: Error,
  revoke?: "manager" | "account" | "directory",
  defaultBranch: string | Error = "main",
) {
  const queries: Array<{ query: string; parameters: unknown[]; transaction: number }> = [];
  const callbacks: Array<{ projectID: string; userID: string; recovering: boolean }> = [];
  const branchReads: Array<{ owner: string; name: string; queryIndex: number }> = [];
  const transactions: string[] = [];
  let transaction = 0;
  let revoked = false;
  function connection(id: number) {
    return Object.assign(
      async (parts: TemplateStringsArray) => {
        const query = parts.join("?");
        queries.push({ query, parameters: [], transaction: id });
        if (!query.includes("pg_advisory_xact_lock")) throw new Error(`Unexpected SQL: ${query}`);
        if (query.includes("factory-account-policy")) revoked = Boolean(revoke);
        return [];
      },
      {
        unsafe(query: string, parameters: unknown[]) {
          queries.push({ query, parameters, transaction: id });
          let rows: unknown[][] = [];
          if (query.includes('from "auth"."user"')) rows = [[userID]];
          else if (query.includes('from "factory"."account_access"'))
            rows = [
              [
                revoked && revoke === "account" ? new Date(createdAt) : null,
                revoked && revoke === "directory" ? new Date(createdAt) : null,
              ],
            ];
          else if (query.includes('from "factory"."project"'))
            rows = query.includes("count(")
              ? [
                  ["river-landscape", 1],
                  ["the-harvesters", 1],
                  ["mountainous-landscape", 1],
                  ["gulf-of-marseille", 1],
                  ["scene-on-the-ice", 1],
                ]
              : query.includes('"operation"')
                ? [[projectID, userID]]
                : projectRows;
          else if (query.includes('from "factory"."administrator"'))
            rows = revoked && revoke === "manager" ? [] : [[userID]];
          else if (query.startsWith('insert into "factory"."project"')) {
            if (failure) throw failure;
            rows = projectRows;
          } else if (
            !query.startsWith('insert into "factory"."project_membership"') &&
            !query.startsWith('insert into "factory"."operation"')
          )
            throw new Error(`Unexpected query: ${query}`);
          return Object.assign(Promise.resolve(rows), { values: async () => rows });
        },
      },
    );
  }
  const client = Object.assign(connection(0), {
    async begin<T>(operation: (sql: postgres.TransactionSql) => Promise<T>) {
      const id = ++transaction;
      transactions.push(`begin:${id}`);
      try {
        const value = await operation(connection(id) as unknown as postgres.TransactionSql);
        transactions.push(`commit:${id}`);
        return value;
      } catch (cause) {
        transactions.push(`rollback:${id}`);
        throw cause;
      }
    },
  }) as unknown as postgres.Sql;
  const database = { client, db: drizzleTransaction(client) } as ReturnType<typeof createDatabase>;
  const service = createProjectService({
    database,
    localRepositoryOrigin: "https://forge.test",
    forgeOwner: "factory",
    readDefaultBranch: async (repository: { owner: string; name: string }) => {
      expect(transactions.at(-1)).toMatch(/^commit:/);
      branchReads.push({ ...repository, queryIndex: queries.length });
      if (defaultBranch instanceof Error) throw defaultBranch;
      return defaultBranch;
    },
    onRegistered: async (projectID, userID, recovering) => {
      if (!recovering) expect(transactions.at(-1)).toMatch(/^commit:/);
      callbacks.push({ projectID, userID, recovering });
    },
  });
  return { service, queries, callbacks, branchReads, transactions };
}

test("project registration keeps Forge reads outside locked authorization and persistence transactions", async () => {
  const f = fixture();
  const saved = await f.service.register(userID, input);
  expect(saved).toEqual({
    id: projectID,
    ...input,
    desktopBackgroundKey: "moonlit-landscape",
    createdAt,
  });
  const writes = f.queries.filter(({ query }) => query.startsWith("insert into"));
  expect(writes).toHaveLength(3);
  const firstWrite = writes[0];
  if (!firstWrite) throw new Error("Project insert was not executed");
  const transaction = firstWrite.transaction;
  expect(transaction).toBeGreaterThan(0);
  expect(writes.every((write) => write.transaction === transaction)).toBe(true);
  const lock = f.queries.findIndex(
    ({ query, transaction: id }) => query.includes("factory-account-policy") && id === transaction,
  );
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(f.queries[lock]?.transaction).toBe(transaction);
  expect(f.queries.indexOf(firstWrite)).toBeGreaterThan(lock);
  const authority = f.queries.findIndex(
    ({ query, transaction: id }) =>
      id === transaction && query.startsWith('select "user_id" from "factory"."administrator"'),
  );
  expect(authority).toBeGreaterThan(lock);
  expect(authority).toBeLessThan(f.queries.indexOf(firstWrite));
  expect(f.branchReads).toEqual([
    { owner: "factory", name: input.slug, queryIndex: expect.any(Number) },
  ]);
  const initialAuthority = f.queries.findIndex(
    ({ query, transaction: id }) =>
      id !== transaction && query.startsWith('select "user_id" from "factory"."administrator"'),
  );
  expect(initialAuthority).toBeGreaterThanOrEqual(0);
  expect(f.branchReads[0]?.queryIndex).toBeGreaterThan(initialAuthority);
  expect(f.branchReads[0]?.queryIndex).toBeLessThanOrEqual(lock);
  expect(f.transactions).toEqual(["begin:1", "commit:1", "begin:2", "commit:2"]);
  expect(writes[0]?.query).toContain("default");
  expect(writes[0]?.parameters).toContain("moonlit-landscape");
  expect(writes[0]?.parameters).not.toContain(createdAt);
  const membership = writes[1];
  const insert = membership?.query.match(/\(([^)]+)\) values \(([^)]+)\)/);
  if (!membership || !insert?.[1] || !insert[2])
    throw new Error("Membership insert was not executed");
  const values = insert[2].split(",").map((value) => value.trim());
  const bindings = Object.fromEntries(
    insert[1].split(",").map((column, index) => {
      const parameter = values[index]?.match(/^\$(\d+)$/);
      return [
        column.trim().replaceAll('"', ""),
        parameter ? membership.parameters[Number(parameter[1]) - 1] : values[index],
      ];
    }),
  );
  expect(bindings).toMatchObject({
    project_id: writes[0]?.parameters[0],
    user_id: userID,
    role: "developer",
    manage_project: true,
    updated_by: userID,
  });
  expect(writes[2]?.parameters).toContain("projects.setup_readiness");
  expect(JSON.stringify(writes[2]?.parameters)).toContain("configuration");
  expect(f.callbacks).toEqual([{ projectID, userID, recovering: false }]);
});

test.each(["", ".git"])(
  "project registration rejects a repository-name/slug mismatch before writes (suffix '%s')",
  async (suffix) => {
    const f = fixture();
    await expect(
      f.service.register(userID, {
        ...input,
        slug: "native-observation-4777f596",
        repositoryUrl: `https://forge.test/factory/factory-source-perf-d6b1f748${suffix}`,
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "Project repository name must match its slug.",
    });
    expect(f.queries.filter(({ query }) => query.startsWith("insert into"))).toHaveLength(0);
    expect(f.callbacks).toHaveLength(0);
    expect(f.branchReads).toHaveLength(0);
    expect(f.transactions.at(-1)).toMatch(/^rollback:/);
  },
);

test("project registration rejects a non-default branch before writes or setup", async () => {
  const f = fixture();
  await expect(
    f.service.register(userID, { ...input, defaultBranch: "codex/alternate-branch" }),
  ).rejects.toMatchObject({
    code: "invalid",
    message: "Project branch must match the repository default branch.",
  });
  expect(f.branchReads).toEqual([
    { owner: "factory", name: input.slug, queryIndex: expect.any(Number) },
  ]);
  expect(f.queries.filter(({ query }) => query.startsWith("insert into"))).toHaveLength(0);
  expect(f.callbacks).toHaveLength(0);
  expect(f.transactions.at(-1)).toMatch(/^rollback:/);
});

test("project registration accepts a matching default branch other than main", async () => {
  const row = [...projectRow];
  row[5] = "trunk";
  const f = fixture([row], undefined, undefined, "trunk");
  expect(await f.service.register(userID, { ...input, defaultBranch: "trunk" })).toMatchObject({
    defaultBranch: "trunk",
  });
  expect(f.branchReads).toHaveLength(1);
  expect(f.callbacks).toHaveLength(1);
});

test("project registration refuses an unconfirmed default branch without persisting or leaking errors", async () => {
  const f = fixture(undefined, undefined, undefined, new Error("private Forge transport detail"));
  await expect(f.service.register(userID, input)).rejects.toMatchObject({
    code: "unavailable",
    message:
      "Factory could not confirm the repository default branch. Check Forgejo access and try again.",
  });
  expect(f.branchReads).toHaveLength(1);
  expect(f.queries.filter(({ query }) => query.startsWith("insert into"))).toHaveLength(0);
  expect(f.callbacks).toHaveLength(0);
  expect(f.transactions.at(-1)).toMatch(/^rollback:/);
});

test.each(["manager", "account", "directory"] as const)(
  "project registration rejects %s revocation while waiting for the account-policy lock",
  async (revoke) => {
    const f = fixture(undefined, undefined, revoke);
    await expect(f.service.register(userID, input)).rejects.toMatchObject({
      code: "forbidden",
      message:
        revoke === "manager" ? "System Manager access required" : "Account access is disabled",
    });
    expect(f.queries.filter(({ query }) => query.startsWith("insert into"))).toHaveLength(0);
    expect(f.callbacks).toHaveLength(0);
    expect(f.branchReads).toHaveLength(0);
    expect(f.transactions.at(-1)).toMatch(/^rollback:/);
  },
);

test("project registration preserves slug conflicts through Drizzle's query error", async () => {
  const f = fixture(undefined, Object.assign(new Error("duplicate slug"), { code: "23505" }));
  await expect(f.service.register(userID, input)).rejects.toMatchObject({
    code: "conflict",
    message: "A Project with that slug already exists",
  });
  expect(f.transactions.at(-1)).toMatch(/^rollback:/);
  expect(f.queries.filter(({ query }) => query.startsWith("insert into"))).toHaveLength(1);
  expect(f.callbacks).toHaveLength(0);
});

test("project registration never reports success without a returned row", async () => {
  const f = fixture([]);
  await expect(f.service.register(userID, input)).rejects.toThrow("Project insert returned no row");
  expect(f.callbacks).toHaveLength(0);
  expect(f.transactions.at(-1)).toMatch(/^rollback:/);
});

test("project list keeps membership visibility and timestamp output on standalone reads", async () => {
  const f = fixture();
  expect((await f.service.list(userID)).projects[0]).toMatchObject({ id: projectID, createdAt });
  const read = f.queries.find(({ query }) => query.includes('from "factory"."project"'));
  expect(read?.transaction).toBe(0);
  expect(read?.query).toContain('exists (select "user_id" from "factory"."administrator"');
  expect(read?.query).toContain(
    '"factory"."project_membership"."project_id" = "factory"."project"."id"',
  );
  expect(read?.query).toContain('order by "factory"."project"."created_at" desc');
  expect(read?.parameters).toEqual([userID, userID]);
});

test("project recovery selects pending configuration without repository intent", async () => {
  const f = fixture();
  await f.service.recover();
  expect(f.callbacks).toEqual([{ projectID, userID, recovering: true }]);
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.transaction).toBe(0);
  expect(f.queries[0]?.query).toContain('inner join "factory"."operation"');
  expect(f.queries[0]?.query).toContain('not exists (select "id"');
  expect(f.queries[0]?.parameters).toEqual([
    "projects.setup_readiness",
    "project",
    "pending",
    "projects.repository_intent",
    "project",
  ]);
  expect(f.transactions).toHaveLength(0);
});
