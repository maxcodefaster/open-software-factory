import type { createDatabase, DatabaseTransaction } from "../../../../packages/db/src/client";

export type ComputeResources = { cpuMilli: number; memoryMiB: number };
export type ComputeAllocation = ComputeResources & { sandboxes: number };
type SQL = ReturnType<typeof createDatabase>["client"] | DatabaseTransaction;

// Caller holds factory-execution-capacity until the native Attempt is inserted.
export async function computeAllocationIn(sql: SQL, projectID: string | null) {
  const [allocation] = await sql<ComputeAllocation[]>`
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
