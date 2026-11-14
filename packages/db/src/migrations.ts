import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type MigrationFile = { version: number; name: string };

export const migrationDirectory = resolve(import.meta.dir, "../migrations");

export function migrationFiles(names: string[]): MigrationFile[] {
  const files = names
    .map((name) => ({ name, match: /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name) }))
    .filter((file) => file.match)
    .map((file) => ({ name: file.name, version: Number(file.match?.[1]) }))
    .sort((a, b) => a.version - b.version);
  if (files.length !== 1 || files[0]?.name !== "0001_baseline.sql")
    throw new Error("Factory ships one Greenfield baseline, not a historical migration sequence");
  return files;
}

/** A retained installation must match the sole native baseline exactly. */
export function pendingMigrations(files: MigrationFile[], applied: number[]) {
  if (
    files.length !== 1 ||
    files[0]?.name !== "0001_baseline.sql" ||
    files[0]?.version !== 1 ||
    applied.length !== 1 ||
    applied[0] !== 1
  )
    throw new Error(
      "Factory requires its Greenfield baseline in a fresh database; historical migration state was not changed",
    );
  return [];
}

export function baselineDigest(source: string) {
  const marker = "-- Baseline registration.\n";
  const parts = source.split(marker);
  const digest = createHash("sha256")
    .update(parts[0] ?? "")
    .digest("hex");
  const registered = parts[1]?.match(
    /^INSERT INTO factory\.schema_migration\(version,source_digest\) VALUES\(1,'([a-f0-9]{64})'\);\nCOMMIT;\n$/,
  );
  if (parts.length !== 2 || registered?.[1] !== digest)
    throw new Error("Factory native baseline registration differs from its exact SQL source");
  return digest;
}

export async function readMigration(file: MigrationFile) {
  return readFile(resolve(migrationDirectory, file.name), "utf8");
}

export async function shippedMigrations() {
  return migrationFiles(await readdir(migrationDirectory));
}
