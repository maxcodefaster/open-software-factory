import postgres from "postgres";
import { waitForPostgres } from "./readiness.ts";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in your environment settings");
const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  connect_timeout: 2,
  connection: { statement_timeout: 2000 },
  onnotice: () => {},
});
try {
  await waitForPostgres(() => sql`SELECT 1`);
} finally {
  await sql.end({ timeout: 2 });
}
