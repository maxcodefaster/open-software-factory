import { and, asc, eq, isNull, not } from "drizzle-orm";
import { z } from "zod";
import { usageRate } from "../../../../packages/conversation-domain/src/usage";
import {
  currentComputeView,
  usageSettingsView,
} from "../../../../packages/conversation-domain/src/usage-view";
import type { createDatabase } from "../../../../packages/db/src/client";
import { runtimeAttempt, substrateBinding } from "../../../../packages/db/src/schema";
import { createAccessController } from "../access/controller";
import { createContractRates } from "./contract-rates";
import { createUsagePolicy } from "./policy";

export function createUsageService(database: ReturnType<typeof createDatabase>) {
  const policies = createUsagePolicy(database);
  const rates = createContractRates(database);
  const access = createAccessController(database);
  return {
    async get(userID: string, projectID: string | null) {
      return usageSettingsView.parse(await policies.get(userID, projectID));
    },
    set: policies.set,
    setRate: rates.set,
    async rates(userID: string) {
      return {
        rates: z
          .array(
            z.object({
              provider: z.string(),
              model: z.string(),
              version: z.number(),
              rate: usageRate.nullable(),
            }),
          )
          .parse(await rates.list(userID)),
      };
    },
    async compute(userID: string, projectID: string | null) {
      const authorize = () =>
        projectID ? access.requireProject(userID, projectID) : access.requireSystemManager(userID);
      await authorize();
      const attempts = await database.db
        .select({
          id: runtimeAttempt.id,
          createdAt: runtimeAttempt.createdAt,
          kind: runtimeAttempt.isolatedKind,
        })
        .from(runtimeAttempt)
        .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
        .where(
          and(
            isNull(substrateBinding.deletedAt),
            not(substrateBinding.createRejected),
            projectID === null ? undefined : eq(runtimeAttempt.projectId, projectID),
          ),
        )
        .orderBy(asc(runtimeAttempt.createdAt))
        .limit(64);
      // Actor-level limits are allocations, not measured consumption. The
      // pinned API does not return per-Actor CPU/RAM samples. Never substitute
      // a shared Worker Pod's aggregate or report missing data as zero.
      const values = attempts.slice(0, 16).map((attempt) => ({
        id: attempt.id,
        kind: attempt.kind ?? "development",
        startedAt: new Date(attempt.createdAt).toISOString(),
        status: "unavailable",
        timestamp: null,
        cpuMilli: null,
        memoryMiB: null,
      }));
      // An awaited observation does not retain an account's authority.
      await authorize();
      return currentComputeView.parse({ observations: values, hasMore: attempts.length > 16 });
    },
  };
}
