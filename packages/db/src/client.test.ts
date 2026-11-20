import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { drizzleTransaction } from "./client";
import { authUser } from "./schema";

function connection(rows: unknown[][]) {
  const statements: Array<{ text: string; parameters: unknown[] }> = [];
  const client = {
    unsafe(text: string, parameters: unknown[]) {
      statements.push({ text, parameters });
      return { values: async () => rows };
    },
    begin() {
      throw new Error("The adapter must not open another transaction");
    },
  } as unknown as postgres.TransactionSql;
  return { client, statements };
}

test("typed queries stay on an existing transaction without requiring pool options", async () => {
  const id = crypto.randomUUID();
  const owned = connection([[id, "Owned account"]]);
  const db = drizzleTransaction(owned.client);
  const rows = await db
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(eq(authUser.id, id));
  expect(rows).toEqual([{ id, name: "Owned account" }]);
  expect(owned.statements).toHaveLength(1);
  expect(owned.statements[0]?.text).toContain('from "auth"."user"');
  expect(owned.statements[0]?.parameters).toEqual([id]);
  expect(drizzleTransaction(owned.client)).toBe(db);
});

test("transaction adapters do not share a connection or retain another transaction's rows", async () => {
  const first = connection([["First"]]);
  const second = connection([["Second"]]);
  const a = drizzleTransaction(first.client);
  const b = drizzleTransaction(second.client);
  expect(a).not.toBe(b);
  expect(await a.select({ name: authUser.name }).from(authUser)).toEqual([{ name: "First" }]);
  expect(await b.select({ name: authUser.name }).from(authUser)).toEqual([{ name: "Second" }]);
  expect(first.statements).toHaveLength(1);
  expect(second.statements).toHaveLength(1);
});
