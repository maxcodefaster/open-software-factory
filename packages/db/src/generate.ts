import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "./schema";

const nativeDirectory = resolve(import.meta.dir, "../native");
const baseline = resolve(import.meta.dir, "../migrations/0001_baseline.sql");

/** Build-time composition only. Installations execute the single sealed SQL baseline. */
export async function generateBaseline() {
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  const namespaces = statements.filter((statement) => statement.startsWith("CREATE SCHEMA "));
  const enums = statements.filter((statement) => statement.startsWith("CREATE TYPE "));
  const tables = statements.filter(
    (statement) => !statement.startsWith("CREATE SCHEMA ") && !statement.startsWith("CREATE TYPE "),
  );
  const files = (await readdir(nativeDirectory))
    .filter((file) => /^\d{2}-[a-z-]+\.sql$/.test(file))
    .sort();
  const beforeTables: string[] = [];
  const afterTables: string[] = [];
  for (const file of files) {
    const source = await readFile(resolve(nativeDirectory, file), "utf8");
    const section = `-- Native ${file}.\n${source.trim()}\n`;
    (Number(file.slice(0, 2)) < 40 ? beforeTables : afterTables).push(section);
  }
  const source = [
    "-- Generated from Drizzle models and owned native PostgreSQL protections. Do not edit.",
    "BEGIN;",
    ...namespaces,
    "SET LOCAL search_path = factory, public;",
    ...enums,
    ...beforeTables,
    ...tables,
    ...afterTables,
    "",
  ].join("\n");
  const digest = createHash("sha256").update(source).digest("hex");
  return `${source}-- Baseline registration.\nINSERT INTO factory.schema_migration(version,source_digest) VALUES(1,'${digest}');\nCOMMIT;\n`;
}

if (import.meta.main) {
  const source = await generateBaseline();
  if (process.argv.includes("--check")) {
    if ((await readFile(baseline, "utf8")) !== source)
      throw new Error("Database baseline differs from its sources; run bun run db:generate");
  } else {
    await writeFile(baseline, source);
  }
}
