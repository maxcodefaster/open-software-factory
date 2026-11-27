import type { createDatabase } from "#db/client";

type Database = ReturnType<typeof createDatabase>;

// A session lock must live across external I/O or inference without occupying
// the application pool used by authorization, usage and ordinary requests.
// This connection does only coordination and is closed with the operation.
export async function withSetupCoordinationLock(
  database: Database,
  lockKey: string,
  work: () => Promise<void>,
): Promise<void> {
  const connection = database.coordination();
  try {
    const [claimed] = await connection<
      { held: boolean }[]
    >`SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS held`;
    if (!claimed?.held) return;
    try {
      await work();
    } finally {
      await connection`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
    }
  } finally {
    await connection.end({ timeout: 1 });
  }
}
