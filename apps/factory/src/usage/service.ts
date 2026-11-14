import { z } from "zod";
import { usageRate } from "../../../../packages/conversation-domain/src/usage";
import {
  currentComputeView,
  usageSettingsView,
} from "../../../../packages/conversation-domain/src/usage-view";
import type { createDatabase } from "../../../../packages/db/src/client";
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
      const attempts = await database.client<
        Array<{
          id: string;
          createdAt: Date;
          kind: string;
        }>
      >`
        SELECT attempt.id,
          attempt.created_at AS "createdAt",coalesce(attempt.isolated_kind::text,'development') AS kind
        FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
        WHERE binding.deleted_at IS NULL AND NOT binding.create_rejected
        AND (${projectID}::uuid IS NULL OR attempt.project_id=${projectID}) ORDER BY attempt.created_at LIMIT 64`;
      // Actor-level limits are allocations, not measured consumption. The
      // pinned API does not return per-Actor CPU/RAM samples. Never substitute
      // a shared Worker Pod's aggregate or report missing data as zero.
      const values = attempts.slice(0, 16).map((attempt) => ({
        id: attempt.id,
        kind: attempt.kind,
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
