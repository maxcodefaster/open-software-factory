import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type ExecutionSlot,
  type ReservePolicy,
  type ReserveRole,
  requireReservePolicy,
  reserveCreationCount,
  reserveIdentity,
} from "../../../../packages/runtime-domain/src/reserve";
import {
  configuredFactoryboxRuntimeProfile,
  type FactoryboxRuntimeProfile,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import { admitComputeIn, ComputeCapacityError } from "../usage/compute";
import { lockUsageIn } from "../usage/policy";

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;

export type { ExecutionSlot } from "../../../../packages/runtime-domain/src/reserve";

const fields =
  'id,role,state,runtime_host_image AS "runtimeHostImage",factorybox_worker_id AS "workerID",kubernetes_namespace AS namespace,namespace_uid AS "namespaceUID",pod_uid AS "podUID",claim_uid AS "claimUID",expires_at AS "expiresAt",assigned_attempt_id AS "assignedAttemptID",factorybox_profile AS "factoryboxProfile",factorybox_identity AS "factoryboxIdentity",factorybox_preparation AS "factoryboxPreparation",factorybox_start_attempted AS "factoryboxStartAttempted",factorybox_pause_attempted AS "factoryboxPauseAttempted",factorybox_resume_attempted AS "factoryboxResumeAttempted",factorybox_delete_attempted AS "factoryboxDeleteAttempted"';
export const executionCapacityLock = "factory-execution-capacity";

export function createReserveStore(
  policyInput: ReservePolicy,
  images: Readonly<Record<ReserveRole, string>>,
  profile?: FactoryboxRuntimeProfile,
) {
  const policy = requireReservePolicy(policyInput);
  for (const image of Object.values(images))
    if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Execution slots require pinned host images");
  async function lock(sql: SQL) {
    await lockUsageIn(sql);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${executionCapacityLock}))`;
  }
  async function counts(sql: SQL) {
    const [result] = await sql<Array<{ execution: number; spare: number; creating: number }>>`
      SELECT (SELECT count(*)::int FROM factory.runtime_attempt WHERE state NOT IN ('stopped','failed')
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_compute_wait WHERE attempt_id=factory.runtime_attempt.id)) AS execution,
        count(*) FILTER(WHERE state IN ('creating','ready','retiring'))::int AS spare,
        count(*) FILTER(WHERE state='creating')::int AS creating FROM factory.execution_slot`;
    if (!result) throw new Error("Execution capacity observation missing");
    return result;
  }
  return {
    async plan(sql: SQL) {
      await lock(sql);
      const selected = policy.readyPerRole
        ? (profile ?? configuredFactoryboxRuntimeProfile())
        : null;
      await sql`UPDATE factory.execution_slot SET state='retiring',reconcile_after=now()
        WHERE state IN ('creating','ready') AND (expires_at<=now() OR
          ${policy.readyPerRole === 0} OR
          factorybox_profile IS DISTINCT FROM ${selected ? JSON.stringify(selected) : null}::text::jsonb OR
          (state='creating' AND created_at<=now()-${policy.preparationMS}*interval '1 millisecond') OR
          (role='staging' AND runtime_host_image<>${images.staging}) OR
          (role='verification' AND runtime_host_image<>${images.verification}))`;
      for (const role of ["staging", "verification"] as const) {
        const budget = await counts(sql);
        const [matching] = await sql<Array<{ count: number; recentFailure: boolean }>>`
          SELECT count(*) FILTER(WHERE state IN ('creating','ready') AND runtime_host_image=${images[role]})::int AS count,
            coalesce(bool_or(assigned_attempt_id IS NULL AND
              (state='retiring' OR (state='deleted' AND reconcile_after>now()))),false) AS "recentFailure"
          FROM factory.execution_slot WHERE role=${role}`;
        if (matching?.recentFailure) continue;
        const count = reserveCreationCount(policy, { ...budget, matching: matching?.count ?? 0 });
        for (let index = 0; index < count; index++) {
          try {
            await admitComputeIn(sql, null, role);
          } catch (cause) {
            if (!(cause instanceof ComputeCapacityError)) throw cause;
            break;
          }
          const identity = reserveIdentity(crypto.randomUUID());
          await sql`INSERT INTO factory.execution_slot(id,role,state,runtime_host_image,expires_at,factorybox_profile)
            VALUES(${identity.id},${role},'creating',${images[role]},now()+${policy.expiryMS}*interval '1 millisecond',${JSON.stringify(selected)}::text::jsonb)`;
        }
      }
      return sql.unsafe<ExecutionSlot[]>(
        `SELECT ${fields} FROM factory.execution_slot WHERE state IN ('creating','retiring') AND reconcile_after<=now() ORDER BY created_at,id LIMIT ${policy.maxSlots}`,
      );
    },
    // Call in the transaction that inserts the immutable Runtime Attempt.
    async admit(
      sql: SQL,
      attemptID: string,
      role?: ReserveRole,
      owner?: {
        projectID: string;
        kind: "development" | "staging" | "verification" | "prebuild" | "publication";
      },
    ) {
      await lock(sql);
      const slot = role
        ? (
            await sql.unsafe<ExecutionSlot[]>(
              `SELECT ${fields} FROM factory.execution_slot
        WHERE state='ready' AND role=$1 AND runtime_host_image=$2 AND factorybox_profile=$3::text::jsonb AND expires_at>now()
        ORDER BY created_at,id FOR UPDATE LIMIT 1`,
              [role, images[role], JSON.stringify(profile ?? configuredFactoryboxRuntimeProfile())],
            )
          )[0]
        : undefined;
      const budget = await counts(sql);
      await admitComputeIn(
        sql,
        owner?.projectID ?? null,
        owner?.kind ?? role ?? "development",
        Boolean(slot),
      );
      if (budget.execution + budget.spare - (slot ? 1 : 0) >= policy.maxExecutionSlots)
        throw new ComputeCapacityError(
          "Execution capacity is occupied. Source editing remains available; retry compute after capacity is released.",
        );
      if (!slot) return null;
      await sql`UPDATE factory.execution_slot SET state='assigned',assigned_attempt_id=${attemptID},assigned_at=now()
        WHERE id=${slot.id} AND state='ready'`;
      return { ...slot, state: "assigned" as const, assignedAttemptID: attemptID };
    },
    async assigned(sql: SQL, attemptID: string) {
      return (
        (
          await sql.unsafe<ExecutionSlot[]>(
            `SELECT ${fields} FROM factory.execution_slot WHERE assigned_attempt_id=$1`,
            [attemptID],
          )
        )[0] ?? null
      );
    },
    async observe(
      sql: SQL,
      id: string,
      observed: {
        namespaceUID: string;
        podUID: string;
        claimUID: string;
        ready: boolean;
        factoryboxIdentity?: unknown;
        factoryboxPreparation?: unknown;
        factoryboxPaused?: boolean;
      },
    ) {
      if (observed.ready) {
        const [started] = await sql`SELECT id FROM factory.execution_slot WHERE id=${id}
          AND factorybox_identity IS NOT NULL AND factorybox_preparation IS NOT NULL
          AND factorybox_start_attempted AND factorybox_pause_attempted`;
        if (!started || observed.factoryboxPaused !== true)
          throw new Error(
            "Execution slot is not ready before its confirmed Factorybox standby Pause",
          );
      }
      await sql`UPDATE factory.execution_slot SET namespace_uid=${observed.namespaceUID},pod_uid=${observed.podUID},claim_uid=coalesce(${observed.claimUID ?? null},claim_uid),
        factorybox_identity=coalesce(factorybox_identity,${observed.factoryboxIdentity === undefined ? null : JSON.stringify(observed.factoryboxIdentity)}::text::jsonb),
        factorybox_preparation=coalesce(factorybox_preparation,${observed.factoryboxPreparation === undefined ? null : JSON.stringify(observed.factoryboxPreparation)}::text::jsonb),
        state=CASE WHEN ${observed.ready} THEN 'ready' ELSE state END,
        reconcile_after=now()+interval '2 seconds' WHERE id=${id} AND state='creating'`;
    },
    async intendStart(sql: SQL, id: string) {
      const result =
        await sql`UPDATE factory.execution_slot SET factorybox_start_attempted=true WHERE id=${id}
        AND state='creating' AND factorybox_identity IS NOT NULL AND factorybox_preparation IS NOT NULL AND NOT factorybox_start_attempted`;
      return result.count === 1;
    },
    async intendStandby(sql: SQL, id: string, action: "pause" | "resume") {
      const result =
        action === "pause"
          ? await sql`UPDATE factory.execution_slot SET factorybox_pause_attempted=true WHERE id=${id}
            AND state='creating' AND factorybox_start_attempted AND NOT factorybox_pause_attempted`
          : await sql`UPDATE factory.execution_slot SET factorybox_resume_attempted=true WHERE id=${id}
            AND state='assigned' AND assigned_attempt_id IS NOT NULL AND factorybox_pause_attempted
            AND NOT factorybox_resume_attempted`;
      return result.count === 1;
    },
    async intendDelete(sql: SQL, id: string) {
      const result = await sql`UPDATE factory.execution_slot SET factorybox_delete_attempted=true
        WHERE id=${id} AND state IN ('retiring','assigned') AND NOT factorybox_delete_attempted`;
      return result.count === 1;
    },
    async defer(sql: SQL, id: string) {
      await sql`UPDATE factory.execution_slot SET reconcile_after=now()+${policy.retryMS}*interval '1 millisecond'
        WHERE id=${id} AND state IN ('creating','retiring')`;
    },
    async retired(sql: SQL, id: string) {
      await sql`UPDATE factory.execution_slot SET state='deleted',reconcile_after=now()+${policy.retryMS}*interval '1 millisecond' WHERE id=${id} AND state='retiring'`;
    },
    async retire(sql: SQL, id: string) {
      await sql`UPDATE factory.execution_slot SET state='retiring',reconcile_after=now() WHERE id=${id} AND state IN ('creating','ready')`;
    },
    async usedRemoved(sql: SQL, attemptID: string) {
      await sql`UPDATE factory.execution_slot SET state='deleted' WHERE assigned_attempt_id=${attemptID} AND state='assigned'`;
    },
    images,
  };
}
