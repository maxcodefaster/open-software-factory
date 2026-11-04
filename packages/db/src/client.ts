import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function databaseURL() {
  const { DATABASE_URL } = process.env;
  if (DATABASE_URL) return DATABASE_URL;
  if (process.env["NODE_ENV"] === "production")
    throw new Error("DATABASE_URL is required when NODE_ENV is production");
  return "postgresql://factory:factory-local-only@127.0.0.1:57432/factory";
}

export function createDatabase(max = 10) {
  const url = databaseURL();
  const client = postgres(url, { max });
  return {
    client,
    db: drizzle(client, { schema }),
    coordination: () => postgres(url, { max: 1, idle_timeout: 0 }),
  };
}
