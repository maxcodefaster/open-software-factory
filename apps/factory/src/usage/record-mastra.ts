import type { createDatabase } from "../../../../packages/db/src/client";
import { createUsageJournal, type UsageOperation } from "./journal";
import type { MastraUsageSink } from "./mastra";
import { createContractRates } from "./contract-rates";

export function recordedMastraUsage(
  database: ReturnType<typeof createDatabase>,
  input: Omit<UsageOperation, "engine" | "rate"> & { engine?: UsageOperation["engine"] },
): MastraUsageSink {
  const journal = createUsageJournal(database);
  return {
    async begin() {
      const rate = await createContractRates(database).get(input.provider, input.model);
      await journal.begin({ ...input, engine: input.engine ?? "mastra", rate });
    },
    record: (value) => journal.record(input.id, value),
    settle: (outcome) => journal.settle(input.id, outcome),
  };
}
