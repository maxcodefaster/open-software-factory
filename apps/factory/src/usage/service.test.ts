import { expect, test } from "bun:test";
import type postgres from "postgres";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { createUsageService } from "./service";

function fixture(count: number, revokeAfterRead = false) {
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const queries: Array<{ query: string; parameters: unknown[]; transaction: number }> = [];
  const startedAt = "2026-11-20T09:15:00.000Z";
  const attempts = Array.from({ length: count }, (_, index) => [
    crypto.randomUUID(),
    startedAt,
    index === 0 ? null : "verification",
  ]);
  let disabled = false;
  let transactions = 0;
  function connection(transaction: number) {
    return {
      unsafe(query: string, parameters: unknown[]) {
        queries.push({ query, parameters, transaction });
        let rows: unknown[][];
        if (query.includes('from "auth"."user"')) rows = [[userID]];
        else if (query.includes('from "factory"."account_access"'))
          rows = [[disabled ? startedAt : null, null]];
        else if (query.includes('from "factory"."project_membership"'))
          rows = [["developer", false]];
        else if (query.includes('from "factory"."administrator"')) rows = [[userID]];
        else if (query.includes('from "factory"."project"')) rows = [[projectID]];
        else if (query.includes('from "factory"."runtime_attempt"')) {
          rows = attempts;
          if (revokeAfterRead) disabled = true;
        } else throw new Error(`Unexpected query: ${query}`);
        return { values: async () => rows };
      },
    };
  }
  const client = Object.assign(connection(0), {
    begin: async <T>(operation: (sql: postgres.TransactionSql) => Promise<T>) =>
      operation(connection(++transactions) as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  const database = { client, db: drizzleTransaction(client) } as ReturnType<typeof createDatabase>;
  return { service: createUsageService(database), userID, projectID, queries, startedAt, attempts };
}

test.each([0, 16, 17])(
  "compute preserves the observation cap and unavailable measurements for %i attempts",
  async (count) => {
    const f = fixture(count);
    const result = await f.service.compute(f.userID, f.projectID);
    expect(result.hasMore).toBe(count > 16);
    expect(result.observations).toHaveLength(Math.min(count, 16));
    if (count) {
      const firstID = f.attempts[0]?.[0];
      if (typeof firstID !== "string") throw new Error("Missing owned attempt ID");
      expect(result.observations[0]).toEqual({
        id: firstID,
        kind: "development",
        startedAt: f.startedAt,
        status: "unavailable",
        timestamp: null,
        cpuMilli: null,
        memoryMiB: null,
      });
      expect(result.observations[1]?.kind).toBe("verification");
    }
    const read = f.queries.find(({ query }) => query.includes('from "factory"."runtime_attempt"'));
    expect(read?.transaction).toBe(0);
    expect(read?.query).toContain('inner join "factory"."substrate_binding"');
    expect(read?.query).toContain('"substrate_binding"."deleted_at" is null');
    expect(read?.query).toContain('not "factory"."substrate_binding"."create_rejected"');
    expect(read?.query).toContain('"runtime_attempt"."project_id" = $1');
    expect(read?.query).toContain('order by "factory"."runtime_attempt"."created_at" asc limit $2');
    expect(read?.parameters).toEqual([f.projectID, 64]);
    const authorization = f.queries.filter(({ query }) => query.includes('from "auth"."user"'));
    expect(authorization.map(({ transaction }) => transaction)).toEqual([1, 2]);
  },
);

test("system compute reads all Projects without a nullable UUID predicate", async () => {
  const f = fixture(1);
  expect((await f.service.compute(f.userID, null)).observations).toHaveLength(1);
  const read = f.queries.find(({ query }) => query.includes('from "factory"."runtime_attempt"'));
  expect(read?.query).not.toContain('"runtime_attempt"."project_id" =');
  expect(read?.parameters).toEqual([64]);
  expect(
    f.queries.filter(({ query }) => query.includes('from "factory"."administrator"')),
  ).toHaveLength(2);
});

test("compute rejects revoked authority after its awaited read instead of returning observations", async () => {
  const f = fixture(1, true);
  await expect(f.service.compute(f.userID, f.projectID)).rejects.toMatchObject({
    code: "forbidden",
    message: "Account access is disabled",
  });
  expect(
    f.queries.filter(({ query }) => query.includes('from "factory"."runtime_attempt"')),
  ).toHaveLength(1);
  expect(f.queries.at(-1)?.transaction).toBe(2);
});
