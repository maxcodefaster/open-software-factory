import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  factoryboxBackingRequest,
  factoryboxRetirementPart,
  factoryboxSlotRetirementRequest,
  readFactoryboxBackingRetirement,
} from "../../../../packages/runtime-kubernetes/src/factorybox-retention";
import {
  type FactoryboxRuntimeInput,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeRequest,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  executeFactoryboxOperation,
  type FactoryboxWorkerIdentity,
  factoryboxOperationFailure,
  factoryboxWorkerIdentity,
  runFactoryboxKubernetes,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import { completeSlotRetirement, completeSlotRetirementPart } from "./reserve-store";

type SQL = ReturnType<typeof createDatabase>["client"];
type Current = { request: FactoryboxRuntimeInput; identity: FactoryboxWorkerIdentity };
type Source = {
  workerID: string;
  sandboxID: string;
  identity: unknown;
  terminal: unknown;
};
type Pending = Source & { id: string; ownerID: string; request: unknown; deleted: unknown };
type PendingSlot = Source & {
  id: string;
  assignedAttemptID: string | null;
  request: unknown;
  progress: unknown;
};
export type RetiredBackingCursor = { attempts: string | null; slots: string | null };
const storeRoot = "/var/lib/sysbox/fixed-store/data/store";

export function retainedFactoryboxBackingOperation(
  current: Current,
  source: Source,
  input: unknown,
) {
  const identity = factoryboxWorkerIdentity.parse(source.identity);
  const request = factoryboxBackingRequest.parse(input);
  z.object({
    kind: z.literal("operator-recovery"),
    podUID: z.literal(identity.podUID),
    namespaceUID: z.literal(identity.namespaceUID),
    phase: z.enum(["Failed", "Succeeded"]),
  }).parse(source.terminal);
  if (
    source.workerID !== current.request.workerID ||
    request.sandbox_id !== source.sandboxID ||
    identity.storeID !== current.identity.storeID ||
    identity.claimUID !== current.identity.claimUID ||
    identity.namespaceUID !== current.identity.namespaceUID ||
    identity.bootID !== current.identity.bootID ||
    identity.nodeBootID !== current.identity.nodeBootID ||
    identity.boundedBytes !== current.identity.boundedBytes ||
    identity.podUID === current.identity.podUID ||
    identity.epoch === current.identity.epoch ||
    current.identity.controllerRoot !==
      `${storeRoot}/epochs/${current.identity.epoch}/controller` ||
    identity.controllerRoot !== `${storeRoot}/epochs/${identity.epoch}/controller`
  )
    throw new Error("Retained cleanup differs from its original worker, store or deleted Sandbox");
  return {
    action: "retire-sandbox" as const,
    sandboxID: request.sandbox_id,
    sandboxOwner: request.sandbox_owner,
    inputSHA256: request.input_sha256,
    sourceRoot: identity.controllerRoot,
  };
}

// Called under the shared worker lifecycle lock. These are storage outcomes,
// never a new Start, RAM recovery or replacement of an old Runtime Attempt.
export async function reclaimRetiredFactoryboxBacking(
  sql: SQL,
  current: Current,
  cursor: RetiredBackingCursor,
  run = runFactoryboxKubernetes,
  execute = executeFactoryboxOperation,
): Promise<RetiredBackingCursor> {
  const [active] = await sql`SELECT admission.id
    FROM factory.runtime_attempt attempt
    JOIN factory.factorybox_runtime saved ON saved.runtime_attempt_id=attempt.id
    JOIN factory.factorybox_worker_admission admission ON admission.id=attempt.factorybox_admission_id
    WHERE attempt.id=${current.request.attemptID}
      AND admission.worker_id=${current.request.workerID} AND admission.retired_at IS NULL
      AND saved.identity=${JSON.stringify(current.identity)}::text::jsonb
      AND admission.identity=saved.identity`;
  if (!active) throw new Error("Retained cleanup requires the exact current worker admission");
  const attempts = await sql<Pending[]>`SELECT operation.id,attempt.id AS "ownerID",
      admission.worker_id AS "workerID",saved.request->>'sandboxID' AS "sandboxID",
      saved.identity,admission.retirement_observation AS terminal,operation.request,
      deleted.observation AS deleted
    FROM factory.factorybox_lifecycle_operation operation
    JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
    JOIN factory.factorybox_runtime saved ON saved.runtime_attempt_id=attempt.id
    JOIN factory.factorybox_worker_admission admission ON admission.id=attempt.factorybox_admission_id
    JOIN factory.factorybox_lifecycle_operation deleted ON deleted.runtime_attempt_id=attempt.id
      AND deleted.action='delete' AND deleted.completed_at IS NOT NULL
    WHERE operation.action='retire-sandbox' AND operation.completed_at IS NULL
      AND attempt.state IN ('stopped','failed') AND admission.retired_at IS NOT NULL
      AND admission.retirement_observation->>'kind'='operator-recovery'
      AND admission.worker_id=${current.request.workerID} AND saved.identity=admission.identity
      AND NOT EXISTS (SELECT 1 FROM factory.factorybox_lifecycle_operation pending
        WHERE pending.runtime_attempt_id=attempt.id
          AND pending.action IN ('retire-checkpoint','retire-resume') AND pending.completed_at IS NULL)
      AND (${cursor.attempts}::uuid IS NULL OR operation.id>${cursor.attempts}::uuid)
    ORDER BY operation.id LIMIT 16`;
  async function retire(source: Source, request: unknown) {
    const operation = retainedFactoryboxBackingOperation(current, source, request);
    const result = await execute(
      factoryboxRuntimeRequest(current.request),
      current.identity,
      operation,
      run,
      factoryboxRuntimeDeclaration(current.request),
    );
    if (!result.confirmed) throw factoryboxOperationFailure("retire-sandbox", result.stderr);
    const receipt = readFactoryboxBackingRetirement(
      factoryboxBackingRequest.parse(request),
      operation.sourceRoot,
      JSON.parse(result.stdout),
    );
    return {
      action: "retire-sandbox" as const,
      controllerRoot: operation.sourceRoot,
      request: receipt.request,
      intentSHA256: receipt.intent_sha256,
      completedAt: receipt.completed_at,
      availableBytesBefore: receipt.before.filesystem_available_bytes,
      availableBytesAfter: receipt.after.filesystem_available_bytes,
    };
  }
  for (const source of attempts) {
    try {
      const request = factoryboxBackingRequest.parse(source.request);
      retainedFactoryboxBackingOperation(current, source, request);
      z.object({
        id: z.literal(request.sandbox_id),
        owner: z.literal(request.sandbox_owner),
        inputSHA256: z.literal(request.input_sha256),
        phase: z.literal("deleted"),
      }).parse(source.deleted);
      await sql`UPDATE factory.factorybox_lifecycle_operation
        SET attempted_at=coalesce(attempted_at,now()) WHERE id=${source.id} AND completed_at IS NULL`;
      const part = await retire(source, request);
      await sql`UPDATE factory.factorybox_lifecycle_operation SET completed_at=now(),
        observation=${JSON.stringify({
          version: 1,
          payloadKind: "sandbox-backing",
          ...part,
          recoveredBy: { podUID: current.identity.podUID, epoch: current.identity.epoch },
        })}::text::jsonb WHERE id=${source.id} AND completed_at IS NULL`;
      await sql`UPDATE factory.factorybox_runtime SET inputs_released_at=now()
        WHERE runtime_attempt_id=${source.ownerID} AND inputs_released_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM factory.factorybox_lifecycle_operation pending
          WHERE pending.runtime_attempt_id=${source.ownerID}
            AND pending.action IN ('retire-checkpoint','retire-resume','retire-sandbox')
            AND pending.completed_at IS NULL)`;
    } catch {
      console.error("Factorybox retained backing needs observation", source.ownerID);
    }
  }
  const slots = await sql<PendingSlot[]>`SELECT slot.id,
      slot.assigned_attempt_id AS "assignedAttemptID",
      admission.worker_id AS "workerID",'runtime-'||replace(slot.id::text,'-','') AS "sandboxID",
      slot.factorybox_identity AS identity,admission.retirement_observation AS terminal,
      slot.factorybox_retirement_request AS request,slot.factorybox_retirement_progress AS progress
    FROM factory.execution_slot slot
    JOIN factory.factorybox_worker_admission admission ON admission.id=slot.factorybox_admission_id
    WHERE slot.state='deleted'
      AND slot.factorybox_retirement_request IS NOT NULL
      AND slot.factorybox_retirement_observation IS NULL AND admission.retired_at IS NOT NULL
      AND admission.retirement_observation->>'kind'='operator-recovery'
      AND admission.worker_id=${current.request.workerID} AND slot.factorybox_identity=admission.identity
      AND (${cursor.slots}::uuid IS NULL OR slot.id>${cursor.slots}::uuid)
    ORDER BY slot.id LIMIT 16`;
  for (const source of slots) {
    try {
      const request = factoryboxSlotRetirementRequest.parse(source.request);
      const operation = retainedFactoryboxBackingOperation(current, source, request.backing);
      const identity = factoryboxWorkerIdentity.parse(source.identity);
      if (request.storeID !== identity.storeID || request.epoch !== identity.epoch)
        throw new Error("Retired slot changed its original store or epoch");
      const progress = z.array(factoryboxRetirementPart).parse(source.progress);
      if (progress.some((part) => part.controllerRoot !== operation.sourceRoot))
        throw new Error("Retired slot has a foreign native receipt");
      const receipts = [];
      for (const [action, generations] of [
        ["retire-checkpoint", request.checkpoints],
        ["retire-resume", request.resumes],
      ] as const)
        for (const generation of generations) {
          const part = progress.find(
            (part) => part.action === action && isDeepStrictEqual(part.request, generation),
          );
          if (!part) throw new Error("Retired checkpoint outcome remains unconfirmed");
          receipts.push(part);
        }
      let backing = progress.find(
        (part) =>
          part.action === "retire-sandbox" && isDeepStrictEqual(part.request, request.backing),
      );
      if (!backing) {
        backing = await retire(source, request.backing);
        await completeSlotRetirementPart(sql, source.id, backing);
      }
      receipts.push(backing);
      await completeSlotRetirement(sql, source.id, {
        version: 1,
        request,
        receipts: receipts.map(({ controllerRoot: _root, ...receipt }) => receipt),
        recoveredBy: { podUID: current.identity.podUID, epoch: current.identity.epoch },
      });
      if (source.assignedAttemptID)
        await sql`UPDATE factory.factorybox_runtime saved SET inputs_released_at=now()
          FROM factory.runtime_attempt attempt
          WHERE attempt.id=${source.assignedAttemptID} AND saved.runtime_attempt_id=attempt.id
            AND attempt.state IN ('stopped','failed') AND saved.inputs_released_at IS NULL
            AND saved.identity=${JSON.stringify(source.identity)}::text::jsonb
            AND saved.request->>'sandboxID'=${request.sandboxID}
            AND saved.request->>'runtimeOwnerID'=${source.id}
            AND saved.request->>'sharedSource'='false'
            AND NOT EXISTS (SELECT 1 FROM factory.factorybox_lifecycle_operation pending
              WHERE pending.runtime_attempt_id=attempt.id
                AND pending.action IN ('retire-checkpoint','retire-resume','retire-sandbox')
                AND pending.completed_at IS NULL)`;
    } catch {
      console.error("Factorybox retained slot backing needs observation", source.id);
    }
  }
  return {
    attempts: attempts.length === 16 ? (attempts.at(-1)?.id ?? null) : null,
    slots: slots.length === 16 ? (slots.at(-1)?.id ?? null) : null,
  };
}
