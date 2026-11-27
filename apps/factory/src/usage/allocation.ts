import type { createDatabase, DatabaseTransaction } from "#db/client";

export type ComputeResources = { cpuMilli: number; memoryMiB: number };
export type ComputeAllocation = ComputeResources & { sandboxes: number };
type SQL = ReturnType<typeof createDatabase>["client"] | DatabaseTransaction;

// Caller holds factory-execution-capacity until the native Attempt/Browser intent is inserted.
export async function computeAllocationIn(sql: SQL, projectID: string | null) {
  const [allocation] = await sql<ComputeAllocation[]>`
    WITH allocations AS (
      SELECT coalesce((attempt.binding_intent#>>'{resources,cpuMilli}')::int,1500) AS cpu,
        coalesce((attempt.binding_intent#>>'{resources,memoryMiB}')::int,1024) AS memory
      FROM factory.runtime_attempt attempt
      WHERE attempt.atespace IS NOT NULL AND attempt.deleted_at IS NULL AND NOT attempt.create_rejected
        AND NOT COALESCE((attempt.state='failed' AND attempt.observation#>>'{status,state}'='ACTOR_STATE_CRASHED'
          AND attempt.observation#>'{status,workerAssignment}' IS NULL),false)
        AND (${projectID}::uuid IS NULL OR project_id=${projectID})
      UNION ALL
      SELECT (browser.payload->>'cpuMilli')::int AS cpu,(browser.payload->>'memoryMiB')::int AS memory
      FROM factory.operation browser
        JOIN factory.build_browser_session session ON session.id=browser.id
        JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
      WHERE browser.kind='runtime.browser'
        AND (browser.payload->>'actorDeletedAt') IS NULL
        AND (${projectID}::uuid IS NULL OR attempt.project_id=${projectID})
    ) SELECT count(*)::int AS sandboxes,coalesce(sum(cpu),0)::int AS "cpuMilli",coalesce(sum(memory),0)::int AS "memoryMiB" FROM allocations`;
  if (!allocation) throw new Error("Compute allocation is unavailable");
  return allocation;
}
