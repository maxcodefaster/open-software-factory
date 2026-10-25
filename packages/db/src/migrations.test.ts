import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Factory has one complete Greenfield baseline rather than historical upgrade migrations", async () => {
  const directory = resolve(import.meta.dir, "../migrations");
  const files = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  expect(files).toEqual(["0001_baseline.sql"]);
  const sql = await readFile(resolve(directory, files[0]!), "utf8");
  expect(sql.match(/INSERT INTO factory\.schema_migration\(version\) VALUES \((\d+)\)/g)).toEqual([
    "INSERT INTO factory.schema_migration(version) VALUES (1)",
  ]);
  expect(sql).toContain("CREATE TABLE factory.factorybox_runtime");
  expect(sql).toContain("CREATE TABLE factory.project_release");
  expect(sql).toContain("CREATE PUBLICATION factory_zero_publication");
  expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA factory");
  expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA factory");
  expect(sql).toContain("INSERT INTO factory.installation_maintenance(singleton)");
  expect(sql).toContain("INSERT INTO factory.attachment_storage(singleton,id)");
  expect(sql).not.toContain("qa_recording_enabled");
});
