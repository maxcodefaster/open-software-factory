import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "./client";

const { client } = createDatabase(1);
let locked = false;
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
  await client`SELECT pg_advisory_lock(hashtext('factory-schema-migration'))`;
  locked = true;
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
  if (
    versions[0]?.version !== 1 ||
    versions.length > 2 ||
    (versions.length === 2 && versions[1]?.version !== 2)
  )
    throw new Error(
      "Factory requires its Greenfield baseline in a fresh database; historical migration state was not changed",
    );
  if (versions.length === 1)
    await client.unsafe(
      await readFile(resolve(import.meta.dir, "../migrations/0002_worker_admissions.sql"), "utf8"),
    );
} catch (cause) {
  // A failed transactional step must roll back before releasing the session
  // lock, otherwise 25P02 masks the actual migration error.
  await client`ROLLBACK`;
  throw cause;
} finally {
  if (locked) await client`SELECT pg_advisory_unlock(hashtext('factory-schema-migration'))`;
  await client.end();
}
