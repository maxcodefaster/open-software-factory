import { createDatabase } from "./client";
import { baselineDigest, pendingMigrations, readMigration, shippedMigrations } from "./migrations";
import { waitForDatabase } from "./wait";

const { client } = createDatabase(1);
let locked = false;
try {
  await waitForDatabase(client);
  await client`SELECT pg_advisory_lock(hashtext('factory-schema-migration'))`;
  locked = true;
  const files = await shippedMigrations();
  const baseline = files[0];
  if (!baseline) throw new Error("Factory ships no native baseline");
  const source = await readMigration(baseline);
  const expectedDigest = baselineDigest(source);
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
    await client.unsafe(source);
  }
  const [registered] = await client<{ present: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='factory' AND table_name='schema_migration' AND column_name='source_digest') AS present`;
  if (!registered?.present)
    throw new Error(
      "Factory requires its native Greenfield baseline; historical schemas were not changed",
    );
  const applied = await client<{ version: number }[]>`
    SELECT version FROM factory.schema_migration ORDER BY version
  `;
  pendingMigrations(
    files,
    applied.map((row) => row.version),
  );
  const [identity] = await client<{ digest: string }[]>`
    SELECT source_digest AS digest FROM factory.schema_migration WHERE version=1`;
  if (identity?.digest !== expectedDigest)
    throw new Error(
      "Factory native baseline differs from this image; existing schemas were not changed",
    );
} catch (cause) {
  // A failed transactional step must roll back before releasing the session
  // lock, otherwise 25P02 masks the actual migration error.
  await client`ROLLBACK`.catch(() => undefined);
  throw cause;
} finally {
  if (locked) await client`SELECT pg_advisory_unlock(hashtext('factory-schema-migration'))`;
  await client.end();
}
