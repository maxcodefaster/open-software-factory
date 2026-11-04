import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type MigrationFile = { version: number; name: string };

export const migrationDirectory = resolve(import.meta.dir, "../migrations");

export function migrationFiles(names: string[]): MigrationFile[] {
  const files = names
    .map((name) => ({ name, match: /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name) }))
    .filter((file) => file.match)
    .map((file) => ({ name: file.name, version: Number(file.match?.[1]) }))
    .sort((a, b) => a.version - b.version);
  files.forEach((file, index) => {
    if (file.version !== index + 1)
      throw new Error(`Migration ${file.name} breaks the contiguous version sequence`);
  });
  return files;
}

/** Applied versions must be exactly 1..n with n no newer than the shipped files. */
export function pendingMigrations(files: MigrationFile[], applied: number[]) {
  if (applied[0] !== 1 || applied.some((version, index) => version !== index + 1))
    throw new Error(
      "Factory requires its Greenfield baseline in a fresh database; historical migration state was not changed",
    );
  if (applied.length > files.length)
    throw new Error(
      `The database is at migration ${applied.length}, newer than this Factory (${files.length}); refusing to downgrade`,
    );
  return files.slice(applied.length);
}

export async function readMigration(file: MigrationFile) {
  return readFile(resolve(migrationDirectory, file.name), "utf8");
}

export async function shippedMigrations() {
  return migrationFiles(await readdir(migrationDirectory));
}
