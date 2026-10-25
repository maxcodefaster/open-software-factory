import type { createDatabase } from "../../../../packages/db/src/client";
import {
  currentComputeView,
  usageSettingsView,
} from "../../../../packages/conversation-domain/src/usage-view";
import { usageRate } from "../../../../packages/conversation-domain/src/usage";
import { z } from "zod";
import { createCurrentMetrics } from "../../../../packages/runtime-kubernetes/src/metrics";
import { createAccessController } from "../access/controller";
import { createUsagePolicy } from "./policy";
import { createContractRates } from "./contract-rates";

export function createUsageService(database: ReturnType<typeof createDatabase>) {
  const policies = createUsagePolicy(database);
  const rates = createContractRates(database);
  const metrics = createCurrentMetrics();
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
          namespace: string;
          pod: string;
          uid: string;
          createdAt: Date;
          kind: string;
        }>
      >`
        SELECT id,kubernetes_namespace AS namespace,kubernetes_pod_name AS pod,kubernetes_uid AS uid,created_at AS "createdAt",coalesce(isolated_kind::text,'development') AS kind
        FROM factory.runtime_attempt WHERE state NOT IN ('stopped','failed') AND kubernetes_uid IS NOT NULL
        AND (${projectID}::uuid IS NULL OR project_id=${projectID}) ORDER BY created_at LIMIT 64`;
      const values = [];
      // A single view reads at most sixteen runtimes, four at a time.
      for (let offset = 0; offset < Math.min(attempts.length, 16); offset += 4)
        values.push(
          ...(await Promise.all(
            attempts.slice(offset, offset + 4).map(async (attempt) => ({
              id: attempt.id,
              kind: attempt.kind,
              startedAt: new Date(attempt.createdAt).toISOString(),
              ...(await metrics(attempt.namespace, attempt.pod, attempt.uid)),
            })),
          )),
        );
      // An awaited observation does not retain an account's authority.
      await authorize();
      return currentComputeView.parse({ observations: values, hasMore: attempts.length > 16 });
    },
  };
}
