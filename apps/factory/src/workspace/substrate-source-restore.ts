import { and, eq, sql as expression, gt, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { drizzleTransaction } from "#db/client";
import { developmentWorkspace, runtimeAttempt } from "#db/schema";
import { hashConnectorToken } from "#runtime-domain/identity";
import { CommandError } from "../command-error";
import {
  nativeInputStopIn,
  substrateRuntimePrincipalIn,
  substrateWorkspaceGrantIn,
} from "../runtime/source-api";
import type { PrivateObjects } from "../storage/objects";
import { boundedSourceBody } from "./source-body";
import { checkedBundle, objectKey, verifiedManifest } from "./substrate-source-checkpoints";
import type { SourceHostManager } from "./substrate-source-host";
import {
  classifySourceLease,
  readSourceLease,
  readSourceWriter,
  type SourceDatabase,
  withSourceLock,
} from "./substrate-source-state";
import {
  confirmSourceCheckpoint,
  freezeSourceLease,
  requireSourceRecipient,
  transferSourceOwner,
} from "./substrate-source-transfer";

const restoreCommitSchema = z.strictObject({
  checkpointID: z.uuid(),
  writerEpoch: z.number().int().positive(),
});

export type RestoreEndpointDeps = {
  database: SourceDatabase;
  hosts: SourceHostManager;
  objects: PrivateObjects;
  revoke: (workspaceID: string) => void;
};

export async function handleSourceRestoreEndpoint(
  deps: RestoreEndpointDeps,
  request: Request,
  attemptID: string,
): Promise<Response> {
  if (
    !["GET", "POST"].includes(request.method) ||
    request.headers.get("X-Factory-Source-Protocol") !== "2"
  )
    return new Response(null, { status: 403 });
  if (
    request.headers.has("X-Factory-Source-Continuation") ||
    request.headers.has("X-Factory-Source-Previous-Checkpoint")
  )
    return new Response(null, { status: 400 });
  const commit =
    request.method === "POST"
      ? restoreCommitSchema.safeParse(
          await boundedSourceBody(request)
            .then((body) => JSON.parse(new TextDecoder().decode(body)) as unknown)
            .catch(() => null),
        )
      : null;
  if (commit && !commit.success) return new Response(null, { status: 400 });
  return deps.database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const admitted = alias(runtimeAttempt, "restore_attempt");
    const newer = alias(runtimeAttempt, "newer");
    const [attempt] = await db
      .select({
        workspaceID: developmentWorkspace.id,
        projectID: admitted.projectId,
        userID: admitted.createdBy,
        token: admitted.parentConnectorTokenHash,
        actorUID: admitted.actorUid,
        generation: admitted.generation,
      })
      .from(admitted)
      .innerJoin(
        developmentWorkspace,
        and(
          eq(developmentWorkspace.id, admitted.workspaceId),
          eq(developmentWorkspace.projectId, admitted.projectId),
          expression`${developmentWorkspace.changeId} IS NOT DISTINCT FROM ${admitted.changeId}`,
        ),
      )
      .where(
        and(
          eq(admitted.id, attemptID),
          eq(admitted.state, "starting"),
          isNull(admitted.stopIntendedAt),
          isNull(admitted.deleteIntendedAt),
          isNull(admitted.deletedAt),
          expression`${admitted.bindingIntent}->>'sourceRestoreProtocol'='2'`,
          notExists(
            db
              .select({ id: newer.id })
              .from(newer)
              .where(
                and(
                  eq(newer.workspaceId, admitted.workspaceId),
                  gt(newer.generation, admitted.generation),
                ),
              ),
          ),
        ),
      )
      .for("share", { of: admitted });
    const auth = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (
      !attempt ||
      !auth ||
      hashConnectorToken(auth) !== attempt.token ||
      request.headers.get("X-Factory-Runtime-Actor-UID") !== attempt.actorUID ||
      request.headers.get("X-Factory-Runtime-Generation") !== String(attempt.generation)
    )
      return new Response(null, { status: 403 });
    // Keep the authority transaction's shared locks, but publish Source
    // facts durably on its dedicated connection before any external ACK.
    return withSourceLock(
      deps.database,
      attempt.workspaceID,
      deps.database.client,
      async (owner) => {
        const inputStop = await nativeInputStopIn(sql, attemptID);
        if (inputStop && (!inputStop.resumed || inputStop.completed))
          return new Response(null, { status: 409 });
        if (!inputStop) {
          const principal = await substrateRuntimePrincipalIn(sql, attemptID);
          await substrateWorkspaceGrantIn(deps.database, sql, attempt.workspaceID, principal);
        }
        const initialRow = await readSourceLease(attempt.workspaceID, owner);
        if (!initialRow || !attempt.actorUID) return new Response(null, { status: 409 });
        let state = classifySourceLease(initialRow);
        const receipt = commit?.success ? commit.data : null;
        if (
          state.phase === "actor-live" &&
          state.actorUID === attempt.actorUID &&
          !receipt &&
          !inputStop &&
          !new URL(request.url).search
        ) {
          // A native ROOTFS wake already contains this Actor's canonical
          // checkout. Authorize its retained private import identity, never
          // offer the obsolete initial seed for another materialization.
          const role = await readSourceWriter(state, sql);
          return Response.json(
            {
              version: 2,
              retained: true,
              actorUID: attempt.actorUID,
              writerEpoch: state.writerEpoch,
              changeWriterEpoch: role.epoch,
              readOnly: !role.writable,
              checkpoint: null,
            },
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (state.owner === "actor") {
          // A lost ACK can only confirm the same committed grant. GET never
          // replays a checkpoint over a tree this Actor may already have changed.
          if (
            !receipt ||
            state.phase !== "actor-live" ||
            state.actorUID !== attempt.actorUID ||
            state.writerEpoch !== receipt.writerEpoch ||
            state.checkpoint?.id !== receipt.checkpointID
          )
            return new Response(null, { status: 409 });
          const role = await readSourceWriter(state, sql);
          return Response.json(
            {
              version: 2,
              actorUID: attempt.actorUID,
              ...receipt,
              changeWriterEpoch: role.epoch,
              readOnly: Boolean(inputStop) || !role.writable,
            },
            { headers: { "cache-control": "no-store" } },
          );
        }
        await requireSourceRecipient(state, attempt.actorUID, owner);
        if (!receipt && state.phase !== "service-frozen") {
          // A seed may not have been opened in the IDE before explicit Start.
          // Its publication confirmation commits separately from this request.
          await deps.hosts.ensureService(state, owner);
          const refreshed = await readSourceLease(attempt.workspaceID, owner);
          if (!refreshed) throw new CommandError("unavailable", "Independent Source owner changed");
          state = await confirmSourceCheckpoint(
            await freezeSourceLease(attempt.workspaceID, "service", owner),
            attemptID,
            deps.hosts,
            deps.objects,
            owner,
          );
        }
        if (state.phase !== "service-frozen") return new Response(null, { status: 409 });
        const plannedEpoch = state.writerEpoch + 1;
        if (
          inputStop &&
          (state.checkpoint.id !== inputStop.sourceCheckpointID ||
            plannedEpoch !== inputStop.sourceWriterEpoch)
        )
          return new Response(null, { status: 409 });
        if (state.checkpoint.actorUID === null) {
          if (
            inputStop ||
            !state.seedConfirmedAt ||
            !state.seed ||
            state.checkpoint.seedID !== state.seed.id ||
            state.seed.workspaceID !== attempt.workspaceID
          )
            return new Response(null, { status: 409 });
        } else if (state.checkpoint.actorUID !== attempt.actorUID) {
          const [predecessor] = await db
            .select({ actorUID: runtimeAttempt.actorUid })
            .from(runtimeAttempt)
            .where(
              and(
                eq(runtimeAttempt.workspaceId, attempt.workspaceID),
                expression`${runtimeAttempt.generation}<${attempt.generation}`,
                eq(runtimeAttempt.state, "stopped"),
                expression`${runtimeAttempt.deletedAt} IS NOT NULL`,
                eq(runtimeAttempt.actorUid, state.checkpoint.actorUID),
              ),
            );
          if (!predecessor) return new Response(null, { status: 409 });
        }
        if (receipt) {
          if (receipt.checkpointID !== state.checkpoint.id || receipt.writerEpoch !== plannedEpoch)
            return new Response(null, { status: 409 });
          const role = await readSourceWriter(
            { ...state, writable: true, writerEpoch: plannedEpoch },
            sql,
          );
          await verifiedManifest(deps.objects, state.checkpoint);
          await deps.hosts.stopHost(attempt.workspaceID);
          await transferSourceOwner(state, "actor", deps.revoke, owner, attempt.actorUID);
          // This durable writer grant precedes the ACK. Cold entry or
          // cold Work entry requires that exact confirmation.
          return Response.json(
            {
              version: 2,
              actorUID: attempt.actorUID,
              ...receipt,
              changeWriterEpoch: role.epoch,
              readOnly: Boolean(inputStop) || !role.writable,
            },
            { headers: { "cache-control": "no-store" } },
          );
        }
        const url = new URL(request.url);
        const chunk = url.searchParams.get("chunk");
        if (chunk === null) {
          await verifiedManifest(deps.objects, state.checkpoint);
          const role = await readSourceWriter(
            { ...state, writable: true, writerEpoch: plannedEpoch },
            sql,
          );
          return Response.json(
            {
              version: 2,
              actorUID: attempt.actorUID,
              checkpointActorUID: state.checkpoint.actorUID,
              checkpointSeedID: state.checkpoint.seedID ?? null,
              writerEpoch: plannedEpoch,
              changeWriterEpoch: role.epoch,
              readOnly: Boolean(inputStop) || !role.writable,
              checkpoint: state.checkpoint,
              ...(inputStop ? { inputStop: inputStop.assignment } : {}),
            },
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (
          !/^\d{1,4}$/.test(chunk) ||
          request.headers.get("X-Factory-Source-Writer-Epoch") !== String(plannedEpoch) ||
          url.searchParams.get("checkpoint") !== state.checkpoint.id ||
          Number(chunk) >= state.checkpoint.bundle.chunks.length
        )
          return new Response(null, { status: 409 });
        return new Response(
          new Uint8Array(
            checkedBundle(
              await deps.objects.read(objectKey(state.checkpoint, `chunk-${Number(chunk)}`)),
              state.checkpoint,
              Number(chunk),
            ),
          ).buffer,
          {
            headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
          },
        );
      },
    );
  });
}
