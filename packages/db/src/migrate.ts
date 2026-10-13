import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "./client";

const { client } = createDatabase(1);
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client`SELECT 1`;
      break;
    } catch (cause) {
      if (attempt === 59) throw cause;
      await Bun.sleep(250);
    }
  }
  const current = await client<{ relation: string }[]>`
    SELECT COALESCE(to_regclass('factory.schema_migration')::text, '') AS relation
  `;
  const migrationDirectory = resolve(import.meta.dir, "../migrations");
  if (!current[0]?.relation) {
    const baseline = await readFile(resolve(migrationDirectory, "0000_baseline.sql"), "utf8");
    await client.unsafe(baseline);
  }
  const versions = await client<{ version: number }[]>`
    SELECT version FROM factory.schema_migration
  `;
  const applied = new Set(versions.map((row) => row.version));
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (version === 0 || applied.has(version)) continue;
    await client.unsafe(await readFile(resolve(migrationDirectory, file), "utf8"));
  }
} finally {
  await client.end();
}
