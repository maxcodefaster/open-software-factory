import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type ExtractTablesWithRelations,
} from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle, PostgresJsDatabase, PostgresJsSession } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DatabaseConnection = postgres.Sql | postgres.TransactionSql | postgres.ReservedSql;
export type DatabaseTransaction = postgres.TransactionSql;
const databases = new WeakMap<DatabaseConnection, PostgresJsDatabase<typeof schema>>();
const tables = extractTablesRelationalConfig<ExtractTablesWithRelations<typeof schema>>(
  schema,
  createTableRelationsHelpers,
);
const relationalSchema = {
  fullSchema: schema,
  schema: tables.tables,
  tableNamesMap: tables.tableNamesMap,
};
const dialect = new PgDialect();

/** Bind typed queries to the caller's existing connection, without opening another transaction. */
export function drizzleTransaction(
  client: postgres.ReservedSql,
): Omit<PostgresJsDatabase<typeof schema>, "transaction">;
export function drizzleTransaction(
  client: postgres.Sql | postgres.TransactionSql,
): PostgresJsDatabase<typeof schema>;
export function drizzleTransaction(client: DatabaseConnection) {
  const existing = databases.get(client);
  if (existing) return existing;
  // The public driver constructor configures pool serializers. Transactions have
  // no pool options; Drizzle's native session binds their unsafe/begin methods.
  // Reserved connections expose only queries. Their owner sends BEGIN/COMMIT
  // explicitly; they must not call Drizzle's transaction helper on another pool.
  const db =
    "options" in client
      ? drizzle(client, { schema })
      : new PostgresJsDatabase<typeof schema>(
          dialect,
          new PostgresJsSession(client as unknown as postgres.Sql, dialect, relationalSchema),
          relationalSchema,
        );
  databases.set(client, db);
  return db;
}

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
    db: drizzleTransaction(client),
    coordination: () => postgres(url, { max: 1, idle_timeout: 0 }),
  };
}
