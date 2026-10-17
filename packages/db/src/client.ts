import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function databaseURL() {
  const { DATABASE_URL } = process.env;
  return DATABASE_URL ?? "postgresql://factory:factory-local-only@127.0.0.1:57432/factory";
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
