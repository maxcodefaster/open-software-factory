import { AsyncLocalStorage } from "node:async_hooks";
import { APIError, type DBTransactionAdapter } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, sql as expression } from "drizzle-orm";
import type { createDatabase } from "#db/client";
import { accountAccess, betterAuthSchema, operation } from "#db/schema";

export type AuthDatabase = ReturnType<typeof createDatabase>;

const EXTERNAL_IDENTITY_KIND = "access.external_identity";
const IDENTITY_SETUP_KIND = "access.identity_setup";

const externalIdentityKey = (issuer: string, subject: string) =>
  `${EXTERNAL_IDENTITY_KIND}:${encodeURIComponent(issuer)}:${encodeURIComponent(subject)}`;

export type ExternalIdentityRecord = {
  id: string;
  issuer: string;
  subject: string;
  userId: string;
  directorySubject: string | null;
  createdAt: Date;
};

function toExternalIdentity(row: {
  id: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}): ExternalIdentityRecord {
  return {
    id: row.id,
    issuer: String(row.payload["issuer"] ?? ""),
    subject: String(row.payload["subject"] ?? ""),
    userId: String(row.payload["userId"] ?? ""),
    directorySubject:
      typeof row.payload["directorySubject"] === "string" ? row.payload["directorySubject"] : null,
    createdAt: row.createdAt,
  };
}

export function createOperationBridgedAdapter(db: AuthDatabase["db"]) {
  const currentAuthDB = new AsyncLocalStorage<AuthDatabase["db"]>();
  const trackedDB = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") {
        return ((callback, config) =>
          target.transaction(
            (transaction) =>
              currentAuthDB.run(transaction as unknown as AuthDatabase["db"], () =>
                callback(transaction),
              ),
            config,
          )) as AuthDatabase["db"]["transaction"];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const baseAdapterFactory = drizzleAdapter(trackedDB, {
    provider: "pg",
    schema: { ...betterAuthSchema, accountAccess },
    schemaName: "auth",
    transaction: true,
  });

  const wrapTransactionAdapter = (adapter: DBTransactionAdapter): DBTransactionAdapter => ({
    ...adapter,
    async findOne(data) {
      if (data.model === "externalIdentity") {
        const activeDB = currentAuthDB.getStore() ?? db;
        const where = Object.fromEntries(
          (data.where ?? []).map((item) => [item.field, item.value]),
        );
        const issuer = typeof where["issuer"] === "string" ? where["issuer"] : undefined;
        const subject = typeof where["subject"] === "string" ? where["subject"] : undefined;
        const directorySubject =
          typeof where["directorySubject"] === "string" ? where["directorySubject"] : undefined;
        if (issuer !== undefined && subject !== undefined) {
          const [row] = await activeDB
            .select({
              id: operation.id,
              payload: operation.payload,
              createdAt: operation.createdAt,
            })
            .from(operation)
            .where(
              and(
                eq(operation.kind, EXTERNAL_IDENTITY_KIND),
                eq(operation.idempotencyKey, externalIdentityKey(issuer, subject)),
              ),
            )
            .limit(1);
          return (row ? toExternalIdentity(row) : null) as never;
        }
        if (issuer !== undefined && directorySubject !== undefined) {
          const [row] = await activeDB
            .select({
              id: operation.id,
              payload: operation.payload,
              createdAt: operation.createdAt,
            })
            .from(operation)
            .where(
              and(
                eq(operation.kind, EXTERNAL_IDENTITY_KIND),
                expression`${operation.payload}->>'issuer' = ${issuer}`,
                expression`${operation.payload}->>'directorySubject' = ${directorySubject}`,
              ),
            )
            .limit(1);
          return (row ? toExternalIdentity(row) : null) as never;
        }
        throw new Error("Unsupported externalIdentity query");
      }
      return adapter.findOne(data);
    },
    async create(data) {
      if (data.model === "externalIdentity") {
        const activeDB = currentAuthDB.getStore() ?? db;
        const values = data.data as Record<string, unknown>;
        const id = typeof values["id"] === "string" ? values["id"] : crypto.randomUUID();
        const issuer = String(values["issuer"]);
        const subject = String(values["subject"]);
        const userId = String(values["userId"]);
        const directorySubject =
          typeof values["directorySubject"] === "string" ? values["directorySubject"] : null;
        const createdAt = values["createdAt"] instanceof Date ? values["createdAt"] : new Date();
        const [created] = await activeDB
          .insert(operation)
          .values({
            id,
            kind: EXTERNAL_IDENTITY_KIND,
            scopeType: "user",
            scopeId: userId,
            idempotencyKey: externalIdentityKey(issuer, subject),
            activeKey: null,
            state: "active",
            payload: { issuer, subject, userId, directorySubject },
            createdAt,
          })
          .returning({
            id: operation.id,
            payload: operation.payload,
            createdAt: operation.createdAt,
          });
        if (!created) throw new Error("External identity insert returned no row");
        return toExternalIdentity(created) as never;
      }
      return adapter.create(data);
    },
  });

  const databaseAdapter: typeof baseAdapterFactory = (authOptions) => {
    const adapter = baseAdapterFactory(authOptions);
    return {
      ...wrapTransactionAdapter(adapter),
      transaction: (callback) =>
        adapter.transaction((transaction) => callback(wrapTransactionAdapter(transaction))),
    };
  };

  async function recordIdentitySetupTest(setupCommandID: string, userId: string): Promise<void> {
    const activeDB = currentAuthDB.getStore() ?? db;
    const testedAt = new Date().toISOString();
    const [recorded] = await activeDB
      .update(operation)
      .set({
        payload: expression`${operation.payload} || ${JSON.stringify({
          testedAt,
          testedUserId: userId,
        })}::jsonb`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.id, setupCommandID),
          eq(operation.kind, IDENTITY_SETUP_KIND),
          eq(operation.state, "saved"),
        ),
      )
      .returning({ id: operation.id });
    if (!recorded) throw new APIError("CONFLICT", { message: "Sign-in setup changed" });
  }

  return {
    databaseAdapter,
    recordIdentitySetupTest,
  };
}
