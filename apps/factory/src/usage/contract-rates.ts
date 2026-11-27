import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type UsageRate, usageRate } from "#conversation-domain/usage";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { auditEvent, operation } from "#db/schema";
import { requireSystemManagerIn } from "../access/authority";
import { CommandError } from "../command-error";
import { lockUsageIn } from "./policy";
import { usageCatalogue } from "./rates";

const RATE_OVERRIDE_KIND = "usage.rate_override";
const rateOverrideKey = (provider: string, model: string) =>
  `${RATE_OVERRIDE_KIND}:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;

export const contractRateCommand = z
  .object({
    commandID: z.uuid(),
    version: z.number().int().nonnegative(),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    tiers: usageRate.shape.tiers.nullable(),
  })
  .strict();

export function createContractRates(database: ReturnType<typeof createDatabase>) {
  async function manager(userID: string) {
    await database.client.begin((transaction) =>
      requireSystemManagerIn(transaction, userID, "Contract prices require System management"),
    );
  }
  return {
    async get(provider: string, model: string, transaction?: DatabaseTransaction) {
      const db = transaction ? drizzleTransaction(transaction) : database.db;
      const [row] = await db
        .select({ rate: sql<UsageRate | null>`${operation.payload}->'rate'` })
        .from(operation)
        .where(eq(operation.idempotencyKey, rateOverrideKey(provider, model)));
      return row?.rate ? usageRate.parse(row.rate) : usageCatalogue.get(provider, model);
    },
    async list(userID: string) {
      await manager(userID);
      return database.db
        .select({
          provider: sql<string>`${operation.payload}->>'provider'`,
          model: sql<string>`${operation.payload}->>'model'`,
          version: sql<number>`(${operation.payload}->>'version')::bigint::float8`,
          rate: sql<UsageRate | null>`${operation.payload}->'rate'`,
        })
        .from(operation)
        .where(and(eq(operation.kind, RATE_OVERRIDE_KIND), eq(operation.scopeType, "model")))
        .orderBy(
          asc(sql`${operation.payload}->>'provider'`),
          asc(sql`${operation.payload}->>'model'`),
        );
    },
    async set(userID: string, raw: unknown) {
      const input = contractRateCommand.parse(raw);
      return database.client.begin(async (transaction) => {
        await requireSystemManagerIn(
          transaction,
          userID,
          "Contract prices require System management",
        );
        await lockUsageIn(transaction);
        const db = drizzleTransaction(transaction);
        const scope = `rate:${input.provider}:${input.model}`;
        const dedupeKey = `usage.policy_command:${input.commandID}`;
        // A canonical schema-parsed input makes JSONB key ordering irrelevant on replay.
        const digest = (value: unknown) =>
          createHash("sha256")
            .update(JSON.stringify(contractRateCommand.parse(value)))
            .digest("hex");
        const [old] = await db
          .select({
            scope: auditEvent.scopeId,
            actorId: auditEvent.actorId,
            input: sql`${auditEvent.payload}->'input'`,
            result: sql`${auditEvent.payload}->'result'`,
          })
          .from(auditEvent)
          .where(eq(auditEvent.dedupeKey, dedupeKey));
        if (old) {
          if (old.actorId !== userID || old.scope !== scope || digest(old.input) !== digest(input))
            throw new CommandError("conflict", "Contract price command changed input");
          return old.result;
        }
        const key = rateOverrideKey(input.provider, input.model);
        const [current] = await db
          .select({ version: sql<number>`(${operation.payload}->>'version')::bigint::float8` })
          .from(operation)
          .where(eq(operation.idempotencyKey, key));
        if ((current?.version ?? 0) !== input.version)
          throw new CommandError("conflict", "Contract prices changed; reload before saving");
        const rate = input.tiers
          ? usageRate.parse({
              provider: input.provider,
              model: input.model,
              source: "contract",
              fetchedAt: new Date().toISOString(),
              tiers: input.tiers,
            })
          : null;
        const result = {
          provider: input.provider,
          model: input.model,
          version: input.version + 1,
          rate,
        };
        const payload = {
          provider: input.provider,
          model: input.model,
          version: result.version,
          rate,
          updatedBy: userID,
        };
        await db
          .insert(operation)
          .values({
            id: crypto.randomUUID(),
            kind: RATE_OVERRIDE_KIND,
            scopeType: "model",
            scopeId: `${input.provider}:${input.model}`,
            idempotencyKey: key,
            activeKey: null,
            state: "active",
            createdBy: userID,
            payload,
          })
          .onConflictDoUpdate({
            target: operation.idempotencyKey,
            set: { createdBy: userID, payload, updatedAt: sql`now()` },
          });
        await db.insert(auditEvent).values({
          id: input.commandID,
          kind: "usage.policy_command",
          scopeType: "execution_policy",
          scopeId: scope,
          actorId: userID,
          dedupeKey,
          payload: {
            commandId: input.commandID,
            scope,
            actorId: userID,
            input,
            result,
          },
        });
        return result;
      });
    },
  };
}
