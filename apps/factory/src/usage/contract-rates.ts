import { z } from "zod";
import { createHash } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import { usageRate } from "../../../../packages/conversation-domain/src/usage";
import { requireActiveAccountIn } from "../access/controller";
import { CommandError } from "../command-error";
import { lockUsageIn } from "./policy";
import { usageCatalogue } from "./rates";
import type { AgentTurnTransaction } from "../agent/turn-store";

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
    await database.client.begin(async (sql) => {
      await requireActiveAccountIn(sql, userID);
      if (!(await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userID}`).length)
        throw new CommandError("forbidden", "Contract prices require System management");
    });
  }
  return {
    async get(provider: string, model: string, transaction?: AgentTurnTransaction) {
      const sql = transaction ?? database.client;
      const [row] = await sql<Array<{ rate: unknown }>>`
        SELECT rate FROM factory.usage_rate_override WHERE provider=${provider} AND model=${model}`;
      return row?.rate ? usageRate.parse(row.rate) : usageCatalogue.get(provider, model);
    },
    async list(userID: string) {
      await manager(userID);
      return database.client<
        Array<{ provider: string; model: string; version: number; rate: unknown }>
      >`
        SELECT provider,model,version::float8 AS version,rate FROM factory.usage_rate_override ORDER BY provider,model`;
    },
    async set(userID: string, raw: unknown) {
      const input = contractRateCommand.parse(raw);
      return database.client.begin(async (sql) => {
        await requireActiveAccountIn(sql, userID);
        if (
          !(await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userID} FOR SHARE`)
            .length
        )
          throw new CommandError("forbidden", "Contract prices require System management");
        await lockUsageIn(sql);
        const scope = `rate:${input.provider}:${input.model}`;
        // A canonical schema-parsed input makes JSONB key ordering irrelevant on replay.
        const digest = (value: unknown) =>
          createHash("sha256")
            .update(JSON.stringify(contractRateCommand.parse(value)))
            .digest("hex");
        const [old] = await sql<
          Array<{ scope: string; actor_id: string; input: unknown; result: unknown }>
        >`
          SELECT scope,actor_id,input,result FROM factory.execution_policy_command WHERE command_id=${input.commandID}`;
        if (old) {
          if (old.actor_id !== userID || old.scope !== scope || digest(old.input) !== digest(input))
            throw new CommandError("conflict", "Contract price command changed input");
          return old.result;
        }
        const [current] = await sql<Array<{ version: number }>>`
          SELECT version::float8 AS version FROM factory.usage_rate_override WHERE provider=${input.provider} AND model=${input.model}`;
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
        await sql`INSERT INTO factory.usage_rate_override(provider,model,version,rate,updated_by)
          VALUES(${input.provider},${input.model},${result.version},${rate ? JSON.stringify(rate) : null}::jsonb,${userID})
          ON CONFLICT(provider,model) DO UPDATE SET version=EXCLUDED.version,rate=EXCLUDED.rate,updated_by=EXCLUDED.updated_by,updated_at=now()`;
        await sql`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
          VALUES(${input.commandID},${scope},${userID},${JSON.stringify(input)}::jsonb,${JSON.stringify(result)}::jsonb)`;
        return result;
      });
    },
  };
}
