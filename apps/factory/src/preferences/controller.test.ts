import { expect, test } from "bun:test";
import type postgres from "postgres";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { defaultDesktopBackgroundKey } from "../../../../packages/interface-domain/src/background";
import { createUIPreferenceController } from "./controller";

test.each([
  { stored: undefined, expected: defaultDesktopBackgroundKey },
  { stored: "not-a-background", expected: defaultDesktopBackgroundKey },
  { stored: "the-harvesters", expected: "the-harvesters" },
])("UI preferences read the saved key or default for $stored", async ({ stored, expected }) => {
  const userID = crypto.randomUUID();
  const queries: Array<{ query: string; parameters: unknown[] }> = [];
  const client = {
    unsafe(query: string, parameters: unknown[]) {
      queries.push({ query, parameters });
      return { values: async () => (stored === undefined ? [] : [[stored]]) };
    },
  } as unknown as postgres.Sql;
  const database = { db: drizzleTransaction(client) } as ReturnType<typeof createDatabase>;
  expect(await createUIPreferenceController(database).get(userID)).toEqual({
    desktopBackgroundKey: expected,
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]?.query).toContain('from "factory"."user_ui_preference"');
  expect(queries[0]?.query).toContain('"user_ui_preference"."user_id" = $1');
  expect(queries[0]?.parameters).toEqual([userID]);
});
