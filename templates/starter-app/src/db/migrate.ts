import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.ts";

const database = createDatabase();
try {
  await migrate(database.db, {
    migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
  });
} finally {
  await database.sql.end({ timeout: 5 });
}
