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
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeProfile,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import { admitComputeIn, ComputeCapacityError } from "../usage/compute";
import { lockUsageIn } from "../usage/policy";
import { retainedFactoryboxProfile } from "./worker";

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;

export type { ExecutionSlot } from "../../../../packages/runtime-domain/src/reserve";

const fields =
  '(SELECT worker.runtime_host_image FROM factory.factorybox_worker worker WHERE singleton) AS "workerRuntimeHostImage",' +
  'seed_expires_at AS "seedExpiresAt",' +
  'id,project_id AS "projectID",staging_attempt_id AS "stagingAttemptID",revision,template_id AS "templateID",template_key AS "templateKey",project_recipe AS "projectRecipe",source_import_sha256 AS "sourceImportSHA256",source_import_observation AS "sourceImportObservation",factorybox_fork_request AS "factoryboxForkRequest",factorybox_fork_attempted AS "factoryboxForkAttempted",factorybox_standby AS "factoryboxStandby",role,state,runtime_host_image AS "runtimeHostImage",factorybox_worker_id AS "workerID",kubernetes_namespace AS namespace,namespace_uid AS "namespaceUID",pod_uid AS "podUID",claim_uid AS "claimUID",expires_at AS "expiresAt",assigned_attempt_id AS "assignedAttemptID",factorybox_profile AS "factoryboxProfile",factorybox_identity AS "factoryboxIdentity",factorybox_preparation AS "factoryboxPreparation",factorybox_start_attempted AS "factoryboxStartAttempted",factorybox_pause_attempted AS "factoryboxPauseAttempted",factorybox_resume_attempted AS "factoryboxResumeAttempted",factorybox_delete_attempted AS "factoryboxDeleteAttempted"';
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
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_compute_wait WHERE attempt_id=factory.runtime_attempt.id)) +
          count(*) FILTER(WHERE template_id IS NULL AND state<>'deleted')::int AS execution,
        count(*) FILTER(WHERE template_id IS NOT NULL AND state IN ('creating','ready','retiring'))::int AS spare,
        count(*) FILTER(WHERE state='creating')::int AS creating FROM factory.execution_slot`;
    if (!result) throw new Error("Execution capacity observation missing");
    return result;
  }
  return {
    async hasTemplate(sql: SQL, key: string) {
      return (
        (
          await sql`SELECT id FROM factory.execution_slot WHERE template_id IS NULL AND template_key=${key}
        AND (state IN ('creating','ready','retiring') OR reconcile_after>now()) LIMIT 1`
        ).length > 0
      );
    },
    async offerTemplate(
      sql: SQL,
      input: {
        id: string;
        projectID: string;
        stagingAttemptID: string;
        revision: string;
        key: string;
        recipe: unknown;
        repositoryURL: string;
        devcontainerPath: string;
        runtimeHostImage: string;
        profile: FactoryboxRuntimeProfile;
      },
    ) {
      await lock(sql);
      if (!policy.readyTarget || (await this.hasTemplate(sql, input.key))) return;
      if (
        input.runtimeHostImage !== images.staging ||
        JSON.stringify(factoryboxRuntimeProfile.parse(input.profile)) !==
          JSON.stringify(await retainedFactoryboxProfile(sql, profile))
      )
        return;
      const budget = await counts(sql);
      if (
        budget.creating >= policy.creationConcurrency ||
        budget.execution + budget.spare >= policy.maxExecutionSlots
      )
        return;
      const [current] = await sql`SELECT staging.id FROM factory.staging_preview preview
        JOIN factory.runtime_attempt staging ON staging.id=preview.runtime_attempt_id
        JOIN factory.project project ON project.id=preview.project_id
        JOIN factory.staging_configuration configuration ON configuration.runtime_attempt_id=staging.id
        WHERE project.id=${input.projectID} AND staging.id=${input.stagingAttemptID}
          AND staging.state='ready' AND staging.stop_intended_at IS NULL
          AND staging.revision=${input.revision} AND preview.revision=${input.revision}
          AND project.repository_url=${input.repositoryURL} AND configuration.declaration->>'devcontainerPath'=${input.devcontainerPath}`;
      if (!current) return;
      await admitComputeIn(sql, input.projectID, "staging");
      await sql`INSERT INTO factory.execution_slot(id,project_id,staging_attempt_id,revision,template_key,project_recipe,seed_expires_at,role,state,runtime_host_image,expires_at,factorybox_profile)
        VALUES(${input.id},${input.projectID},${input.stagingAttemptID},${input.revision},${input.key},${JSON.stringify(input.recipe)}::text::jsonb,
          now()+${policy.expiryMS}*interval '1 millisecond','staging','creating',${input.runtimeHostImage},now()+${policy.expiryMS}*interval '1 millisecond',${JSON.stringify(input.profile)}::text::jsonb)`;
    },
    async plan(sql: SQL) {
      await lock(sql);
      const selected = policy.readyTarget ? await retainedFactoryboxProfile(sql, profile) : null;
      // Finish an already-admitted clean template before retiring its backing.
      // Cancelling before native Start would strand an unregistered input tree.
      await sql`UPDATE factory.execution_slot SET state='retiring',reconcile_after=now()
        WHERE (state='creating' AND created_at<=now()-${policy.preparationMS}*interval '1 millisecond')
        OR (state='creating' AND template_id IS NOT NULL AND NOT factorybox_fork_attempted AND
          (${policy.readyTarget === 0} OR EXISTS(
            SELECT 1 FROM factory.execution_slot source WHERE source.id=execution_slot.template_id AND source.state='retiring')))
        OR (state='ready' AND ((template_id IS NOT NULL AND expires_at<=now()) OR
          ${policy.readyTarget === 0} OR
          factorybox_profile IS DISTINCT FROM ${selected ? JSON.stringify(selected) : null}::text::jsonb OR
          runtime_host_image<>${images.staging} OR NOT EXISTS(
            SELECT 1 FROM factory.staging_preview preview
            JOIN factory.staging_configuration configuration ON configuration.runtime_attempt_id=preview.runtime_attempt_id
            WHERE preview.project_id=execution_slot.project_id AND preview.runtime_attempt_id=execution_slot.staging_attempt_id
              AND preview.revision=execution_slot.revision AND configuration.declaration->>'devcontainerPath'=execution_slot.project_recipe->>'devcontainerPath')))`;
      const [template] = await sql.unsafe<
        ExecutionSlot[]
      >(`SELECT ${fields} FROM factory.execution_slot
        WHERE template_id IS NULL AND state='ready' AND factorybox_standby IS NOT NULL
          ORDER BY created_at DESC,id LIMIT 1`);
      if (template) {
        await sql`UPDATE factory.execution_slot SET state='retiring',reconcile_after=now()
          WHERE (state='ready' OR (state='creating' AND NOT factorybox_fork_attempted))
            AND template_id IS NOT NULL AND template_id<>${template.id}`;
        await sql`UPDATE factory.execution_slot SET state='retiring',reconcile_after=now()
          WHERE state='ready' AND template_id IS NULL AND id<>${template.id}`;
        const budget = await counts(sql);
        const [matching] = await sql<Array<{ count: number; recentFailure: boolean }>>`
          SELECT count(*) FILTER(WHERE state IN ('creating','ready'))::int AS count,
            coalesce(bool_or(assigned_attempt_id IS NULL AND
              (state='retiring' OR (state='deleted' AND reconcile_after>now()))),false) AS "recentFailure"
          FROM factory.execution_slot WHERE template_id=${template.id}`;
        const count = matching?.recentFailure
          ? 0
          : reserveCreationCount(policy, { ...budget, matching: matching?.count ?? 0 });
        for (let index = 0; index < count; index++) {
          const { projectID, stagingAttemptID, revision, templateKey, seedExpiresAt } = template;
          if (!projectID || !stagingAttemptID || !revision || !templateKey || !seedExpiresAt)
            throw new Error("Ready execution template is missing its retained source identity");
          try {
            await admitComputeIn(sql, projectID, "staging");
          } catch (cause) {
            if (!(cause instanceof ComputeCapacityError)) throw cause;
            break;
          }
          const identity = reserveIdentity(crypto.randomUUID());
          await sql`INSERT INTO factory.execution_slot(id,project_id,staging_attempt_id,revision,template_id,template_key,project_recipe,seed_expires_at,role,state,runtime_host_image,expires_at,factorybox_profile)
            VALUES(${identity.id},${projectID},${stagingAttemptID},${revision},${template.id},${templateKey},
              ${JSON.stringify(template.projectRecipe)}::text::jsonb,${seedExpiresAt},'staging','creating',${template.runtimeHostImage},
              now()+${policy.expiryMS}*interval '1 millisecond',${JSON.stringify(selected)}::text::jsonb)`;
        }
      }
      return sql.unsafe<ExecutionSlot[]>(
        `SELECT ${fields} FROM factory.execution_slot slot WHERE state IN ('creating','retiring') AND reconcile_after<=now()
          AND (template_id IS NOT NULL OR state<>'retiring' OR NOT EXISTS(
            SELECT 1 FROM factory.execution_slot child WHERE child.template_id=slot.id AND child.state<>'deleted'))
          ORDER BY CASE WHEN state='retiring' AND template_id IS NOT NULL THEN 0 ELSE 1 END,created_at,id LIMIT ${policy.maxSlots + 1}`,
      );
    },
    async get(sql: SQL, id: string) {
      return (
        (
          await sql.unsafe<ExecutionSlot[]>(
            `SELECT ${fields} FROM factory.execution_slot WHERE id=$1`,
            [id],
          )
        )[0] ?? null
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
      const slot =
        role && owner
          ? (
              await sql.unsafe<ExecutionSlot[]>(
                `SELECT ${fields} FROM factory.execution_slot
        WHERE state='ready' AND template_id IS NOT NULL AND project_id=$1 AND runtime_host_image=$2 AND factorybox_profile=$3::text::jsonb AND expires_at>now()
          AND EXISTS(SELECT 1 FROM factory.staging_preview preview WHERE preview.project_id=execution_slot.project_id
            AND preview.runtime_attempt_id=execution_slot.staging_attempt_id AND preview.revision=execution_slot.revision)
        ORDER BY created_at,id FOR UPDATE LIMIT 1`,
                [
                  owner.projectID,
                  images[role],
                  JSON.stringify(await retainedFactoryboxProfile(sql, profile)),
                ],
              )
            )[0]
          : undefined;
      const budget = await counts(sql);
      await admitComputeIn(
        sql,
        owner?.projectID ?? null,
        owner?.kind ?? role ?? "development",
        Boolean(slot),
        slot?.role ?? owner?.kind ?? role ?? "development",
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
        factoryboxStandby?: unknown;
      },
    ) {
      if (observed.ready) {
        const [started] = await sql`SELECT id FROM factory.execution_slot WHERE id=${id}
          AND factorybox_identity IS NOT NULL AND factorybox_preparation IS NOT NULL
          AND (factorybox_start_attempted OR factorybox_fork_attempted) AND factorybox_pause_attempted`;
        if (!started || observed.factoryboxPaused !== true)
          throw new Error(
            "Execution slot is not ready before its confirmed Factorybox standby Pause",
          );
      }
      await sql`UPDATE factory.execution_slot SET namespace_uid=${observed.namespaceUID},pod_uid=${observed.podUID},claim_uid=coalesce(${observed.claimUID ?? null},claim_uid),
        factorybox_identity=coalesce(factorybox_identity,${observed.factoryboxIdentity === undefined ? null : JSON.stringify(observed.factoryboxIdentity)}::text::jsonb),
        factorybox_preparation=coalesce(factorybox_preparation,${observed.factoryboxPreparation === undefined ? null : JSON.stringify(observed.factoryboxPreparation)}::text::jsonb),
        factorybox_standby=coalesce(factorybox_standby,${observed.factoryboxStandby === undefined ? null : JSON.stringify(observed.factoryboxStandby)}::text::jsonb),
        state=CASE WHEN ${observed.ready} THEN 'ready' ELSE state END,
        reconcile_after=now()+interval '2 seconds' WHERE id=${id} AND state='creating'`;
    },
    async intendStart(sql: SQL, id: string) {
      const result =
        await sql`UPDATE factory.execution_slot SET factorybox_start_attempted=true WHERE id=${id}
        AND state='creating' AND template_id IS NULL AND source_import_observation IS NOT NULL
        AND factorybox_identity IS NOT NULL AND factorybox_preparation IS NOT NULL AND NOT factorybox_start_attempted`;
      return result.count === 1;
    },
    async intendStandby(sql: SQL, id: string, action: "pause" | "resume") {
      const result =
        action === "pause"
          ? await sql`UPDATE factory.execution_slot SET factorybox_pause_attempted=true WHERE id=${id}
            AND state='creating' AND (factorybox_start_attempted OR factorybox_fork_attempted) AND NOT factorybox_pause_attempted`
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
    async intendFork(sql: SQL, id: string, request: unknown) {
      const body = JSON.stringify(request);
      const result =
        await sql`UPDATE factory.execution_slot slot SET factorybox_fork_request=${body}::text::jsonb,
        factorybox_fork_attempted=true FROM factory.execution_slot source
        WHERE slot.id=${id} AND slot.state='creating' AND slot.template_id=source.id AND source.state='ready'
        AND slot.factorybox_identity IS NOT NULL AND NOT slot.factorybox_fork_attempted
        AND ${body}::text::jsonb->>'action'='fork'
        AND ${body}::text::jsonb->>'sandboxID'='runtime-'||replace(slot.id::text,'-','')
        AND ${body}::text::jsonb->>'sourceSandboxID'=source.factorybox_standby->>'sandboxID'
        AND ${body}::text::jsonb->>'sourceOwner'=source.factorybox_standby->>'owner'
        AND ${body}::text::jsonb->>'snapshotID'=source.factorybox_standby->>'snapshotID'
        AND ${body}::text::jsonb->>'checkpointSHA256'=source.factorybox_standby->>'checkpointSHA256'`;
      return result.count === 1;
    },
    async intendSourceImport(sql: SQL, id: string, sha256: string) {
      const result = await sql`UPDATE factory.execution_slot SET source_import_sha256=${sha256}
        WHERE id=${id} AND state='creating' AND template_id IS NULL AND source_import_sha256 IS NULL AND NOT factorybox_start_attempted`;
      return result.count === 1;
    },
    async completeSourceImport(sql: SQL, id: string, observation: unknown) {
      const result =
        await sql`UPDATE factory.execution_slot SET source_import_observation=${JSON.stringify(observation)}::text::jsonb
        WHERE id=${id} AND state IN ('creating','retiring') AND template_id IS NULL AND source_import_observation IS NULL
          AND source_import_sha256=${JSON.stringify(observation)}::text::jsonb->>'sha256'`;
      if (result.count !== 1)
        throw new Error("Source import receipt differs from its original intent");
    },
    async intendRetirement(sql: SQL, id: string, request: unknown) {
      const result = await sql`UPDATE factory.execution_slot
        SET factorybox_retirement_request=coalesce(factorybox_retirement_request,${JSON.stringify(request)}::text::jsonb)
        WHERE id=${id} AND state IN ('retiring','assigned') AND (factorybox_start_attempted OR factorybox_fork_attempted)
        AND (factorybox_retirement_request IS NULL OR factorybox_retirement_request=${JSON.stringify(request)}::text::jsonb)`;
      if (result.count !== 1)
        throw new Error("Execution slot retirement differs from its durable original request");
    },
    async completeRetirement(sql: SQL, id: string, observation: unknown) {
      const result = await sql`UPDATE factory.execution_slot
        SET factorybox_retirement_observation=coalesce(factorybox_retirement_observation,${JSON.stringify(observation)}::text::jsonb)
        WHERE id=${id} AND state IN ('retiring','assigned')
        AND factorybox_retirement_request IS NOT NULL
        AND factorybox_retirement_request=${JSON.stringify(observation)}::text::jsonb->'request'
        AND (factorybox_retirement_observation IS NULL OR factorybox_retirement_observation=${JSON.stringify(observation)}::text::jsonb)`;
      if (result.count !== 1)
        throw new Error(
          "Execution slot retirement observation differs from its original request or outcome",
        );
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
