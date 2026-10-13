import type { createDatabase } from "../../../../packages/db/src/client";
import type { TransactionSql } from "postgres";
import { policyIn, lockUsageIn } from "./policy";
import { CommandError } from "../command-error";

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;
import {
  computeReservation,
  type ComputeClass,
} from "../../../../packages/runtime-domain/src/compute";
export {
  computeReservation,
  type ComputeClass,
} from "../../../../packages/runtime-domain/src/compute";

export class ComputeCapacityError extends CommandError {
  constructor(
    message = "Compute allowance is occupied. Existing work and source editing remain available.",
  ) {
    super("conflict", message);
  }
}

// Caller holds factory-execution-capacity until the attempt/slot identity is inserted.
export async function computeAllocationIn(sql: SQL, projectID: string | null) {
  const [allocation] = await sql<Array<{ sandboxes: number; cpuMilli: number; memoryMiB: number }>>`
    WITH allocations AS (
      SELECT CASE WHEN isolated_kind='staging' THEN 100 WHEN isolated_kind='verification' THEN 250 ELSE 500 END AS cpu,
        CASE WHEN isolated_kind='staging' THEN 256 WHEN isolated_kind='verification' THEN 768 ELSE 1024 END AS memory
      FROM factory.runtime_attempt WHERE state NOT IN ('stopped','failed')
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_compute_wait WHERE attempt_id=factory.runtime_attempt.id)
        AND (${projectID}::uuid IS NULL OR project_id=${projectID})
      UNION ALL SELECT CASE WHEN role='staging' THEN 100 ELSE 250 END, CASE WHEN role='staging' THEN 256 ELSE 768 END
      FROM factory.execution_slot WHERE ${projectID}::uuid IS NULL AND state IN ('creating','ready','retiring') AND assigned_attempt_id IS NULL
    ) SELECT count(*)::int AS sandboxes,coalesce(sum(cpu),0)::int AS "cpuMilli",coalesce(sum(memory),0)::int AS "memoryMiB" FROM allocations`;
  if (!allocation) throw new Error("Compute allocation is unavailable");
  return allocation;
}
export async function admitComputeIn(
  sql: SQL,
  projectID: string | null,
  kind: ComputeClass,
  adoptingSlot = false,
) {
  await lockUsageIn(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtext('factory-execution-capacity'))`;
  const policy = await policyIn(sql, projectID);
  const reservation = computeReservation(kind);
  for (const scope of [
    { id: null, policy: policy.factory },
    ...(projectID ? [{ id: projectID, policy: policy.effective }] : []),
  ]) {
    const used = await computeAllocationIn(sql, scope.id);
    for (const key of ["sandboxes", "cpuMilli", "memoryMiB"] as const) {
      const next = used[key] + (adoptingSlot && scope.id === null ? 0 : reservation[key]);
      const limit = scope.policy[key];
      if (limit !== null && next > limit) throw new ComputeCapacityError();
    }
  }
}
