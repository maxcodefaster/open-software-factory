import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { lockUsageIn, policyIn } from "./policy";

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;

export class ComputeCapacityError extends CommandError {
  constructor(
    message = "Compute allowance is occupied. Existing work and source editing remain available.",
  ) {
    super("conflict", message);
  }
}

// Caller holds factory-execution-capacity until the native Attempt is inserted.
export async function computeAllocationIn(sql: SQL, projectID: string | null) {
  const [allocation] = await sql<Array<{ sandboxes: number; cpuMilli: number; memoryMiB: number }>>`
    WITH allocations AS (
      SELECT coalesce((binding.intent#>>'{resources,cpuMilli}')::int,1500) AS cpu,
        coalesce((binding.intent#>>'{resources,memoryMiB}')::int,1024) AS memory
      FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      WHERE binding.deleted_at IS NULL AND NOT binding.create_rejected
        AND NOT COALESCE((attempt.state='failed' AND binding.observation#>>'{status,state}'='ACTOR_STATE_CRASHED'
          AND binding.observation#>'{status,workerAssignment}' IS NULL),false)
        AND (${projectID}::uuid IS NULL OR project_id=${projectID})
    ) SELECT count(*)::int AS sandboxes,coalesce(sum(cpu),0)::int AS "cpuMilli",coalesce(sum(memory),0)::int AS "memoryMiB" FROM allocations`;
  if (!allocation) throw new Error("Compute allocation is unavailable");
  return allocation;
}
export async function admitComputeIn(
  sql: SQL,
  projectID: string | null,
  resources: { cpuMilli: number; memoryMiB: number },
) {
  if (Object.values(resources).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error("Compute resource reservation must be positive finite integers");
  await lockUsageIn(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtext('factory-execution-capacity'))`;
  const policy = await policyIn(sql, projectID);
  const reservation = { sandboxes: 1, ...resources };
  for (const scope of [
    { id: null, policy: policy.factory },
    ...(projectID ? [{ id: projectID, policy: policy.effective }] : []),
  ]) {
    const used = await computeAllocationIn(sql, scope.id);
    for (const key of ["sandboxes", "cpuMilli", "memoryMiB"] as const) {
      const next = used[key] + reservation[key];
      const limit = scope.policy[key];
      if (limit !== null && next > limit) throw new ComputeCapacityError();
    }
  }
}
