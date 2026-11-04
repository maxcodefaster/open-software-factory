import { createDatabase } from "./client";
import { pendingMigrations, readMigration, shippedMigrations } from "./migrations";
import { waitForDatabase } from "./wait";

const { client } = createDatabase(1);
let locked = false;
try {
  await waitForDatabase(client);
  await client`SELECT pg_advisory_lock(hashtext('factory-schema-migration'))`;
  locked = true;
  const files = await shippedMigrations();
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
    const [baseline] = files;
    if (!baseline) throw new Error("Factory ships no baseline migration");
    await client.unsafe(await readMigration(baseline));
  }
  const applied = await client<{ version: number }[]>`
    SELECT version FROM factory.schema_migration ORDER BY version
  `;
  for (const file of pendingMigrations(
    files,
    applied.map((row) => row.version),
  ))
    await client.unsafe(await readMigration(file));
} catch (cause) {
  // A failed transactional step must roll back before releasing the session
  // lock, otherwise 25P02 masks the actual migration error.
  await client`ROLLBACK`.catch(() => undefined);
  throw cause;
} finally {
  if (locked) await client`SELECT pg_advisory_unlock(hashtext('factory-schema-migration'))`;
  await client.end();
}
