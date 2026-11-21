import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { type ComputeResources, computeAllocationIn } from "./allocation";
import { lockUsageIn, policyIn } from "./policy";

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;

export class ComputeCapacityError extends CommandError {
  constructor(
    message = "Compute allowance is occupied. Existing work and source editing remain available.",
  ) {
    super("conflict", message);
  }
}

export async function admitComputeIn(
  sql: SQL,
  projectID: string | null,
  resources: ComputeResources,
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
