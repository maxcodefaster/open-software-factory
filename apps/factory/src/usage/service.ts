import { z } from "zod";
import { usageRate } from "../../../../packages/conversation-domain/src/usage";
import {
  currentComputeView,
  usageSettingsView,
} from "../../../../packages/conversation-domain/src/usage-view";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createFactoryboxMetrics } from "../../../../packages/runtime-kubernetes/src/factorybox-metrics";
import type { FactoryboxRuntimeInput } from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import { factoryboxWorkerIdentity } from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import { createAccessController } from "../access/controller";
import { createContractRates } from "./contract-rates";
import { createUsagePolicy } from "./policy";

export function createUsageService(database: ReturnType<typeof createDatabase>) {
  const policies = createUsagePolicy(database);
  const rates = createContractRates(database);
  const metrics = createFactoryboxMetrics();
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
          runtime: FactoryboxRuntimeInput | null;
          identity: unknown;
          createdAt: Date;
          kind: string;
        }>
      >`
        SELECT attempt.id,runtime.request AS runtime,runtime.identity,
          attempt.created_at AS "createdAt",coalesce(attempt.isolated_kind::text,'development') AS kind
        FROM factory.runtime_attempt attempt LEFT JOIN factory.factorybox_runtime runtime ON runtime.runtime_attempt_id=attempt.id
        WHERE attempt.state NOT IN ('stopped','failed') AND attempt.kubernetes_uid IS NOT NULL
        AND (${projectID}::uuid IS NULL OR attempt.project_id=${projectID}) ORDER BY attempt.created_at LIMIT 64`;
      const values = [];
      // A single view reads at most sixteen runtimes, four at a time.
      for (let offset = 0; offset < Math.min(attempts.length, 16); offset += 4)
        values.push(
          ...(await Promise.all(
            attempts.slice(offset, offset + 4).map(async (attempt) => ({
              id: attempt.id,
              kind: attempt.kind,
              startedAt: new Date(attempt.createdAt).toISOString(),
              ...(attempt.runtime && factoryboxWorkerIdentity.safeParse(attempt.identity).success
                ? await metrics({
                    input: attempt.runtime,
                    identity: factoryboxWorkerIdentity.parse(attempt.identity),
                  })
                : { status: "unavailable", timestamp: null, cpuMilli: null, memoryMiB: null }),
            })),
          )),
        );
      // An awaited observation does not retain an account's authority.
      await authorize();
      return currentComputeView.parse({ observations: values, hasMore: attempts.length > 16 });
    },
  };
}
