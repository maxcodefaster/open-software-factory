import { createHash } from "node:crypto";
import { and, eq, sql as expression, isNull } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { substrateSource } from "#db/schema";
import { CommandError } from "../command-error";
import { objectDigest, type PrivateObjects } from "../storage/objects";
import { initialSourceActorIn } from "./source-initialization";
import {
  checkedBundle,
  objectKey,
  sourceBundle,
  sourceCheckpoint,
} from "./substrate-source-checkpoints";
import type { SourceHostManager } from "./substrate-source-host";
import {
  type ActorFreezingSourceLease,
  type ActorFrozenSourceLease,
  type ClassifiedSourceLease,
  classifySourceLease,
  type FrozenSourceLease,
  isFrozenLease,
  type NonWritableSourceLease,
  readSourceLease,
  type ServiceFreezingSourceLease,
  type ServiceFrozenSourceLease,
  type SourceSQL,
} from "./substrate-source-state";

export async function freezeSourceLease(
  workspaceID: string,
  owner: "actor",
  sql: SourceSQL,
): Promise<ActorFreezingSourceLease | ActorFrozenSourceLease>;
export async function freezeSourceLease(
  workspaceID: string,
  owner: "service",
  sql: SourceSQL,
): Promise<ServiceFreezingSourceLease | ServiceFrozenSourceLease>;
export async function freezeSourceLease(
  workspaceID: string,
  owner: "actor" | "service",
  sql: SourceSQL,
): Promise<NonWritableSourceLease>;
export async function freezeSourceLease(
  workspaceID: string,
  owner: "actor" | "service",
  sql: SourceSQL,
): Promise<NonWritableSourceLease> {
  let row = await readSourceLease(workspaceID, sql);
  if (!row || row.owner !== owner) throw new CommandError("conflict", "Source owner changed");
  if (row.writable) {
    const id = crypto.randomUUID();
    await drizzleTransaction(sql)
      .update(substrateSource)
      .set({
        writerEpoch: expression`${substrateSource.writerEpoch}+1`,
        writable: false,
        checkpointId: id,
      })
      .where(
        and(
          eq(substrateSource.workspaceId, workspaceID),
          eq(substrateSource.owner, owner),
          eq(substrateSource.writerEpoch, row.writerEpoch),
          eq(substrateSource.writable, true),
        ),
      );
    row = await readSourceLease(workspaceID, sql);
  }
  if (!row || row.writable || !row.checkpointID)
    throw new CommandError("conflict", "Source freeze is unconfirmed");
  const state = classifySourceLease(row);
  if (state.writable) throw new CommandError("conflict", "Source freeze is unconfirmed");
  return state;
}

export async function confirmSourceCheckpoint(
  state: ServiceFreezingSourceLease | ServiceFrozenSourceLease,
  attemptID: string,
  hosts: SourceHostManager,
  objects: PrivateObjects,
  sql: SourceSQL,
): Promise<ServiceFrozenSourceLease>;
export async function confirmSourceCheckpoint(
  state: NonWritableSourceLease,
  attemptID: string,
  hosts: SourceHostManager,
  objects: PrivateObjects,
  sql: SourceSQL,
): Promise<FrozenSourceLease>;
export async function confirmSourceCheckpoint(
  state: NonWritableSourceLease,
  attemptID: string,
  hosts: SourceHostManager,
  objects: PrivateObjects,
  sql: SourceSQL,
): Promise<FrozenSourceLease> {
  if (isFrozenLease(state)) return state;
  const call = (operation: string, value: unknown) =>
    hosts.request(
      state.workspaceID,
      attemptID,
      state,
      operation,
      new Request("http://source.internal/", {
        method: "POST",
        body: JSON.stringify(value),
        signal: AbortSignal.timeout(120_000),
      }),
      sql,
    );
  const identity = { checkpointId: state.checkpointID, writerEpoch: state.writerEpoch };
  const response = await call("checkpoint", identity);
  if (!response.ok) {
    const failure = response.headers.get("X-Factory-Source-Checkpoint-Failure");
    const reason =
      failure &&
      /^(?:io-\d{1,3}|path-boundary|conflicting-writer|size-limit|ownership-mode|entry-type|external-git|xattr-enumeration|xattr-namespace|xattr-value|external-hardlink|unconfirmed)$/.test(
        failure,
      )
        ? `; ${failure}`
        : "";
    await response.body?.cancel();
    throw new CommandError(
      "unavailable",
      `Complete Source checkpoint is unavailable (HTTP ${response.status}${reason}); original owner remains fenced`,
    );
  }
  const bundle = sourceBundle.parse(await response.json());
  const saved = sourceCheckpoint.parse({
    id: state.checkpointID,
    workspaceID: state.workspaceID,
    actorUID: state.actorUID,
    ...(state.actorUID === null ? { seedID: state.seed?.id } : {}),
    writerEpoch: state.writerEpoch,
    generation: state.generation + 1,
    bundle,
  });
  const whole = createHash("sha256");
  for (let i = 0; i < bundle.chunks.length; i++) {
    const chunk = await call("chunk", { ...identity, chunk: i });
    if (!chunk.ok)
      throw new CommandError(
        "unavailable",
        "Source export chunk is unconfirmed; original owner retained",
      );
    const bytes = checkedBundle(new Uint8Array(await chunk.arrayBuffer()), saved, i);
    whole.update(bytes);
    await objects.put(objectKey(saved, `chunk-${i}`), bytes, "application/octet-stream");
  }
  if (whole.digest("hex") !== bundle.sha256)
    throw new CommandError("unavailable", "Complete Source export checksum differs");
  const manifest = new TextEncoder().encode(JSON.stringify(saved));
  await objects.put(objectKey(saved, "manifest.json"), manifest, "application/json");
  if (
    objectDigest(await objects.read(objectKey(saved, "manifest.json"))) !== objectDigest(manifest)
  )
    throw new Error("Source manifest confirmation failed");
  for (let i = 0; i < bundle.chunks.length; i++)
    checkedBundle(await objects.read(objectKey(saved, `chunk-${i}`)), saved, i);
  const result = await drizzleTransaction(sql)
    .update(substrateSource)
    .set({ generation: saved.generation, checkpoint: saved })
    .where(
      and(
        eq(substrateSource.workspaceId, state.workspaceID),
        eq(substrateSource.writerEpoch, state.writerEpoch),
        eq(substrateSource.owner, state.owner),
        eq(substrateSource.writable, false),
        eq(substrateSource.checkpointId, saved.id),
      ),
    )
    .returning({ workspaceID: substrateSource.workspaceId });
  if (result.length !== 1)
    throw new CommandError("conflict", "Source confirmation lost its writer fence");
  const confirmed = await readSourceLease(state.workspaceID, sql);
  if (!confirmed) throw new CommandError("unavailable", "Confirmed Source owner is missing");
  const next = classifySourceLease(confirmed);
  if (!isFrozenLease(next))
    throw new CommandError("conflict", "Source generation is not confirmed");
  return next;
}

export async function transferSourceOwner(
  state: ClassifiedSourceLease,
  owner: "actor" | "service",
  revoke: (workspaceID: string) => void,
  sql: SourceSQL,
  actorUID: string | null = state.actorUID,
) {
  if (!isFrozenLease(state))
    throw new CommandError("conflict", "Source generation is not confirmed");
  revoke(state.workspaceID);
  const result = await drizzleTransaction(sql)
    .update(substrateSource)
    .set({
      owner,
      actorUid: actorUID,
      writerEpoch: expression`${substrateSource.writerEpoch}+1`,
      writable: true,
      checkpointId: null,
      serviceBase: owner === "service" ? state.checkpointID : substrateSource.serviceBase,
    })
    .where(
      and(
        eq(substrateSource.workspaceId, state.workspaceID),
        state.actorUID === null
          ? isNull(substrateSource.actorUid)
          : eq(substrateSource.actorUid, state.actorUID),
        eq(substrateSource.owner, state.owner),
        eq(substrateSource.writerEpoch, state.writerEpoch),
        eq(substrateSource.writable, false),
        eq(substrateSource.checkpointId, state.checkpointID),
      ),
    )
    .returning({ workspaceID: substrateSource.workspaceId });
  if (result.length !== 1)
    throw new CommandError("conflict", "Source owner transfer lost its epoch");
}

export async function requireSourceRecipient(
  state: ClassifiedSourceLease,
  actorUID: string,
  sql: SourceSQL,
) {
  if (state.owner !== "service")
    throw new CommandError("conflict", "Independent Source owner changed");
  const [current] =
    state.actorUID === null && state.seed
      ? await initialSourceActorIn(sql, state.seed, actorUID)
      : await sql<{ id: string }[]>`
        SELECT current.id FROM factory.runtime_attempt current
        JOIN factory.substrate_provision p ON p.owner_id=current.workspace_id AND p.kind='workspace' AND p.generation=current.generation
        WHERE current.workspace_id=${state.workspaceID}
          AND current.state IN ('create-intended','starting','paused')
          AND current.stop_intended_at IS NULL
          AND current.actor_uid=${actorUID} AND NOT current.create_rejected
          AND current.create_attempted_at IS NOT NULL
          AND current.delete_intended_at IS NULL AND current.deleted_at IS NULL
          AND current.binding_intent->>'workspaceID'=${state.workspaceID}
          AND current.binding_intent->>'generation'=current.generation::text
          AND current.binding_intent->>'atespaceUID'=p.resources#>>'{atespace,value,metadata,uid}'
          AND current.binding_intent->>'templateUID'=p.resources#>>'{template,value,metadata,uid}'
          AND current.binding_intent->>'templateVersion'=p.resources#>>'{template,value,metadata,version}'
          AND current.binding_intent->>'templateSHA256'=p.intent->>'templateSHA256'
          AND (${state.actorUID}::uuid=${actorUID}::uuid OR EXISTS(
            SELECT 1 FROM factory.runtime_attempt predecessor
            WHERE predecessor.workspace_id=current.workspace_id
              AND predecessor.generation<current.generation AND predecessor.state='stopped'
              AND predecessor.actor_uid=${state.actorUID} AND predecessor.deleted_at IS NOT NULL
              AND NOT EXISTS(
                SELECT 1 FROM factory.runtime_attempt skipped
                WHERE skipped.workspace_id=current.workspace_id
                  AND skipped.generation>predecessor.generation AND skipped.generation<current.generation
                  AND (skipped.state='stopped' AND skipped.deleted_at IS NOT NULL
                    AND skipped.binding_intent->>'sourceRestoreProtocol'='2') IS NOT TRUE)))
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=current.workspace_id AND newer.generation>current.generation)`;
  if (!current)
    throw new CommandError(
      "conflict",
      "Original Source Actor UID changed without a confirmed native successor",
    );
  return current.id;
}

export async function hasUngrantedStop(workspaceID: string, actorUID: string, sql: SourceSQL) {
  const [attempt] = await sql<{ id: string }[]>`
    SELECT a.id FROM factory.runtime_attempt a
    JOIN factory.substrate_source s ON s.workspace_id=a.workspace_id AND s.owner='service'
    WHERE a.workspace_id=${workspaceID} AND a.stop_intended_at IS NOT NULL
      AND a.actor_uid=${actorUID} AND a.binding_intent->>'sourceRestoreProtocol'='2'
      AND a.create_attempted_at IS NOT NULL AND NOT a.create_rejected
      AND ((a.state='stopping' AND a.deleted_at IS NULL)
        OR (a.state='stopped' AND a.deleted_at IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)`;
  return Boolean(attempt);
}

export async function cancelFrozenServiceImport(
  workspaceID: string,
  state: ServiceFreezingSourceLease | ServiceFrozenSourceLease,
  hosts: SourceHostManager,
  revoke: (workspaceID: string) => void,
  sql: SourceSQL,
) {
  const [attempt] = await sql<{ actorUID: string }[]>`
    SELECT a.actor_uid AS "actorUID" FROM factory.runtime_attempt a
    WHERE a.workspace_id=${workspaceID} AND a.state='stopping'
      AND a.stop_intended_at IS NOT NULL AND a.actor_uid IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)`;
  if (!attempt || !(await hasUngrantedStop(workspaceID, attempt.actorUID, sql)))
    throw new CommandError("conflict", "Source import has not been safely cancelled");
  await hosts.stopHost(workspaceID);
  revoke(workspaceID);
  await drizzleTransaction(sql)
    .update(substrateSource)
    .set({
      writable: true,
      writerEpoch: expression`${substrateSource.writerEpoch}+1`,
      checkpointId: null,
    })
    .where(
      and(
        eq(substrateSource.workspaceId, workspaceID),
        eq(substrateSource.owner, "service"),
        eq(substrateSource.writerEpoch, state.writerEpoch),
        eq(substrateSource.writable, false),
      ),
    );
}
