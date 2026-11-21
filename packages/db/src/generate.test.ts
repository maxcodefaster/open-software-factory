import { expect, test } from "bun:test";
import { is, SQL, StringChunk } from "drizzle-orm";
import { getTableConfig, PgColumn, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { desktopBackgroundKeys } from "../../interface-domain/src/background";
import { generateBaseline } from "./generate";
import { baselineDigest } from "./migrations";
import * as schema from "./schema";

test("personal and Project background guards accept exactly the supported artwork catalog", () => {
  const dialect = new PgDialect();
  for (const table of [schema.userUIPreference, schema.project]) {
    const config = getTableConfig(table);
    const check = config.checks.find((check) =>
      check.name.endsWith("_desktop_background_key_check"),
    );
    if (!check) throw new Error(`${config.name} is missing its artwork guard`);
    const expression = dialect.sqlToQuery(check.value).sql;
    const keys = [...expression.matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
    expect({ table: config.name, keys }).toEqual({
      table: config.name,
      keys: [...desktopBackgroundKeys],
    });
  }
});

test("Drizzle and native sources generate one reproducible sealed baseline", async () => {
  const first = await generateBaseline();
  expect(await generateBaseline()).toBe(first);
  expect(baselineDigest(first)).toMatch(/^[a-f0-9]{64}$/);
  expect(first.indexOf("CREATE SCHEMA")).toBeLessThan(first.indexOf("CREATE EXTENSION"));
  expect(first.indexOf("CREATE TYPE")).toBeLessThan(first.indexOf("CREATE FUNCTION"));
  expect(first.indexOf("CREATE FUNCTION")).toBeLessThan(first.indexOf("CREATE TABLE"));
  expect(first.indexOf("CREATE TABLE")).toBeLessThan(first.indexOf("CREATE TRIGGER"));
  expect(first).toContain("UNIQUE NULLS NOT DISTINCT");
  expect(first).toContain("ALTER CONSTRAINT knowledge_page_parent_project DEFERRABLE");
});

test("schema checks and partial indexes bind column objects rather than bare SQL names", () => {
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const config = getTableConfig(table);
    const names = new Set(config.columns.map((column) => column.name));
    const predicates = [
      ...config.checks.map((check) => ({ name: check.name, sql: check.value })),
      ...config.indexes.flatMap((index) =>
        index.config.where ? [{ name: index.config.name, sql: index.config.where }] : [],
      ),
    ];
    for (const predicate of predicates) {
      let references = 0;
      const bare: string[] = [];
      function inspect(chunk: unknown) {
        if (is(chunk, PgColumn)) references++;
        else if (is(chunk, SQL)) chunk.queryChunks.forEach(inspect);
        else if (is(chunk, StringChunk)) {
          const syntax = chunk.value.join("").replace(/'(?:''|[^'])*'/g, "");
          for (const token of syntax.matchAll(/[A-Za-z_][A-Za-z_0-9]*/g))
            if (names.has(token[0])) bare.push(token[0]);
        }
      }
      inspect(predicate.sql);
      expect({ predicate: predicate.name, bare }).toEqual({
        predicate: predicate.name,
        bare: [],
      });
      expect(references).toBeGreaterThan(0);
    }
  }
});

test("the baseline retains usage update triggers on the shared immutable routine", async () => {
  const baseline = await generateBaseline();
  expect(baseline).not.toContain("CREATE FUNCTION factory.guard_usage_entry()");
  expect(baseline).toContain(
    "CREATE TRIGGER execution_policy_command_immutable BEFORE UPDATE ON factory.execution_policy_command FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();",
  );
  expect(baseline).toContain(
    "CREATE TRIGGER guard_usage_entry BEFORE UPDATE ON factory.usage_entry FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();",
  );
  expect(baseline).toContain(
    "CREATE TRIGGER guard_usage_operation BEFORE UPDATE ON factory.usage_operation FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_operation();",
  );
});
