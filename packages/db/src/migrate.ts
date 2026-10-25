import { readFile } from "node:fs/promises";
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
  if (!current[0]?.relation) {
    const [existing] = await client<{ present: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','factory')) AS present`;
    if (existing?.present)
      throw new Error(
        "Factory requires an empty database for its Greenfield baseline; existing schemas were not changed",
      );
    const baseline = await readFile(
      resolve(import.meta.dir, "../migrations/0001_baseline.sql"),
      "utf8",
    );
    await client.unsafe(baseline);
  }
  const versions = await client<{ version: number }[]>`
    SELECT version FROM factory.schema_migration ORDER BY version
  `;
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new Error(
      "Factory requires its Greenfield baseline in a fresh database; historical migration state was not changed",
    );
} finally {
  await client.end();
}
