import { and, eq, sql as expression, getTableColumns, inArray } from "drizzle-orm";
import { inputInstructions } from "#conversation-domain/monitoring";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { monitoringHook, monitoringIncident, monitoringPolicy } from "#db/schema";
import { CommandError } from "../command-error";
import {
  manageMonitoringIn,
  retainedInputAssignments,
  validateInputAssignmentsIn,
} from "./authority";

// Change only the saved task. Never renew a delegation, rotate a key, enable a
// Hook or reinterpret an admitted event as a request under different guidance.
export async function editInputInstructionsIn(
  database: ReturnType<typeof createDatabase>,
  sql: DatabaseTransaction,
  input: {
    hookId: string;
    policyId: string;
    version: number;
    instructions: string;
    revisionId: string;
    userId: string;
  },
) {
  const instructions = inputInstructions.parse(input.instructions);
  const db = drizzleTransaction(sql);
  const [hook] = await db
    .select({
      projectId: monitoringHook.projectId,
      policyId: monitoringHook.policyId,
      version: monitoringHook.version,
    })
    .from(monitoringHook)
    .where(eq(monitoringHook.id, input.hookId))
    .for("update");
  if (!hook) throw new CommandError("not-found", "Input not found");
  const [policy] = await db
    .select()
    .from(monitoringPolicy)
    .where(eq(monitoringPolicy.id, hook.policyId));
  if (!policy) throw new CommandError("not-found", "Input policy not found");
  await manageMonitoringIn(sql, input.userId, hook.projectId, policy.delegation);
  await manageMonitoringIn(sql, policy.delegatedBy, hook.projectId, policy.delegation);
  if (hook.version !== input.version || hook.policyId !== input.policyId)
    throw new CommandError(
      "conflict",
      "Input instructions changed. Reload the exact current policy.",
    );
  if (policy.instructions === instructions)
    throw new CommandError("invalid", "The edit does not change the saved Input task.");
  const [busy] = await db
    .select({ id: monitoringIncident.id })
    .from(monitoringIncident)
    .where(
      and(
        eq(monitoringIncident.hookId, input.hookId),
        inArray(monitoringIncident.state, ["queued", "diagnosing", "implementing"]),
      ),
    )
    .limit(1);
  if (busy)
    throw new CommandError(
      "conflict",
      "Input work must settle before its saved instructions change.",
    );
  await validateInputAssignmentsIn(
    database,
    sql,
    retainedInputAssignments(policy),
    hook.projectId,
    policy.delegatedBy,
  );
  // Copy in PostgreSQL so the original delegation timestamp keeps microsecond precision.
  await db.insert(monitoringPolicy).select(
    db
      .select({
        ...getTableColumns(monitoringPolicy),
        id: expression<string>`${input.revisionId}::uuid`.as("id"),
        instructions: expression<string>`${instructions}`.as("instructions"),
      })
      .from(monitoringPolicy)
      .where(eq(monitoringPolicy.id, input.policyId)),
  );
  await db
    .update(monitoringHook)
    .set({
      policyId: input.revisionId,
      version: expression`${monitoringHook.version}+1`,
    })
    .where(eq(monitoringHook.id, input.hookId));
  return { revisionId: input.revisionId, version: input.version + 1 };
}
