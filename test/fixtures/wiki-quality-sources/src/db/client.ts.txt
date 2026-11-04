import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

export function createDatabase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Set DATABASE_URL in your environment settings");
  const sql = postgres(url, { max: 5, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}
