import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { executionPolicyCommand } from "../../../../packages/conversation-domain/src/execution-policy";
import { CommandError } from "../command-error";
import { json } from "../http";
import { createUsagePolicy } from "./policy";
import { contractRateCommand, createContractRates } from "./contract-rates";
import { createCurrentMetrics } from "../../../../packages/runtime-kubernetes/src/metrics";
import { createAccessController } from "../access/controller";

export function createUsageRoutes(
  database: ReturnType<typeof createDatabase>,
  auth: { requireFresh(request: Request): Promise<unknown> },
) {
  const policies = createUsagePolicy(database);
  const rates = createContractRates(database);
  const metrics = createCurrentMetrics();
  const access = createAccessController(database);
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    const observations = path.match(/^\/api\/(?:projects\/([0-9a-f-]{36})|admin)\/usage\/compute$/);
    if (observations) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const projectID = observations[1] ? z.uuid().parse(observations[1]) : null;
      if (projectID) await access.requireProject(userID, projectID);
      else await access.requireSystemManager(userID);
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
      for (let offset = 0; offset < Math.min(attempts.length, 16); offset += 4) {
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
      }
      // Recheck after asynchronous observations so a removed member receives no data.
      if (projectID) await access.requireProject(userID, projectID);
      else await access.requireSystemManager(userID);
      return json({ observations: values, hasMore: attempts.length > 16 });
    }
    if (path === "/api/admin/usage/rates") {
      if (request.method === "GET") return json({ rates: await rates.list(userID) });
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      try {
        await auth.requireFresh(request);
      } catch {
        throw new CommandError("forbidden", "Sign in again before changing contract prices");
      }
      const input = contractRateCommand.safeParse(await request.json().catch(() => null));
      if (!input.success) return json({ error: "Contract prices are invalid" }, 400);
      return json(await rates.set(userID, input.data));
    }
    const project = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/usage$/);
    if (path !== "/api/admin/usage" && !project) return undefined;
    const projectID = project ? z.uuid().parse(project[1]) : null;
    if (request.method === "GET") return json(await policies.get(userID, projectID));
    if (request.method !== "PUT") return new Response(null, { status: 405 });
    try {
      await auth.requireFresh(request);
    } catch {
      throw new CommandError("forbidden", "Sign in again before changing Usage & limits");
    }
    const input = executionPolicyCommand.safeParse(await request.json().catch(() => null));
    if (!input.success) return json({ error: "Usage settings are invalid" }, 400);
    return json(await policies.set(userID, projectID, input.data));
  };
}
