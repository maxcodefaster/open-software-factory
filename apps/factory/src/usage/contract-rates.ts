import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { usageRate } from "../../../../packages/conversation-domain/src/usage";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import { executionPolicyCommand, usageRateOverride } from "../../../../packages/db/src/schema";
import { requireSystemManagerIn } from "../access/controller";
import { CommandError } from "../command-error";
import { lockUsageIn } from "./policy";
import { usageCatalogue } from "./rates";

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
        .select({ rate: usageRateOverride.rate })
        .from(usageRateOverride)
        .where(and(eq(usageRateOverride.provider, provider), eq(usageRateOverride.model, model)));
      return row?.rate ? usageRate.parse(row.rate) : usageCatalogue.get(provider, model);
    },
    async list(userID: string) {
      await manager(userID);
      return database.db
        .select({
          provider: usageRateOverride.provider,
          model: usageRateOverride.model,
          version: usageRateOverride.version,
          rate: usageRateOverride.rate,
        })
        .from(usageRateOverride)
        .orderBy(asc(usageRateOverride.provider), asc(usageRateOverride.model));
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
        // A canonical schema-parsed input makes JSONB key ordering irrelevant on replay.
        const digest = (value: unknown) =>
          createHash("sha256")
            .update(JSON.stringify(contractRateCommand.parse(value)))
            .digest("hex");
        const [old] = await db
          .select({
            scope: executionPolicyCommand.scope,
            actorId: executionPolicyCommand.actorId,
            input: executionPolicyCommand.input,
            result: executionPolicyCommand.result,
          })
          .from(executionPolicyCommand)
          .where(eq(executionPolicyCommand.commandId, input.commandID));
        if (old) {
          if (old.actorId !== userID || old.scope !== scope || digest(old.input) !== digest(input))
            throw new CommandError("conflict", "Contract price command changed input");
          return old.result;
        }
        const [current] = await db
          .select({ version: usageRateOverride.version })
          .from(usageRateOverride)
          .where(
            and(
              eq(usageRateOverride.provider, input.provider),
              eq(usageRateOverride.model, input.model),
            ),
          );
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
        await db
          .insert(usageRateOverride)
          .values({
            provider: input.provider,
            model: input.model,
            version: result.version,
            rate,
            updatedBy: userID,
          })
          .onConflictDoUpdate({
            target: [usageRateOverride.provider, usageRateOverride.model],
            set: { version: result.version, rate, updatedBy: userID, updatedAt: sql`now()` },
          });
        await db.insert(executionPolicyCommand).values({
          commandId: input.commandID,
          scope,
          actorId: userID,
          input,
          result,
        });
        return result;
      });
    },
  };
}
