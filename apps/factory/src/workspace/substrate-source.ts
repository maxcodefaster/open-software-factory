import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import { createPrivateObjects, type PrivateObjects } from "../storage/objects";
import { type SourceStartupConfiguration, sourceStartupConfiguration } from "./source-startup";
import { fenceSourceWriter, forwardSourceRequest } from "./substrate-source-access";
import { sourceBundle, sourceCheckpointObjects } from "./substrate-source-checkpoints";
import { createSourceHostManager } from "./substrate-source-host";
import { handleSourceRestoreEndpoint } from "./substrate-source-restore";
import {
  type ClassifiedSourceLease,
  classifySourceLease,
  isLiveServiceLease,
  readSourceLease,
  readSourceWriter,
  type SourceDatabase,
  type SourceLeasePhase,
  type SourceSQL,
  type SubstrateSourceLeaseRow,
  withSourceLock,
} from "./substrate-source-state";
import {
  cancelFrozenServiceImport,
  confirmSourceCheckpoint,
  freezeSourceLease,
  hasUngrantedStop,
  requireSourceRecipient,
  transferSourceOwner,
} from "./substrate-source-transfer";

export {
  type ClassifiedSourceLease,
  classifySourceLease,
  type SourceLeasePhase,
  type SubstrateSourceLeaseRow as SubstrateSourceLease,
  sourceBundle,
  sourceCheckpointObjects,
};

export type SubstrateSourceHandoff = Pick<
  ReturnType<typeof createSubstrateSources>,
  "attach" | "freezeActor" | "makeIndependent" | "resume" | "requireIndependent"
> &
  Partial<Pick<ReturnType<typeof createSubstrateSources>, "startupConfiguration">>;

// Source ownership has its own short lock. Native Resume waits for bootstrap,
// which must be able to import Source without waiting on that Runtime lock.
export function createSubstrateSources(
  database: SourceDatabase,
  hub: RuntimeHub,
  objects: PrivateObjects = createPrivateObjects(),
) {
  let revoke = (_workspaceID: string) => {};
  const hosts = createSourceHostManager(database, hub, objects);
  const lease = (workspaceID: string, sql: SourceSQL = database.client) =>
    readSourceLease(workspaceID, sql);

  return {
    lease,
    async startupConfiguration(
      workspaceID: string,
      actorTemplatePath: string,
      sql: SourceSQL,
    ): Promise<SourceStartupConfiguration | undefined> {
      return withSourceLock(database, workspaceID, sql, async (sql) => {
        let row = await lease(workspaceID, sql);
        if (!row) return;
        const state = classifySourceLease(row);
        if (!isLiveServiceLease(state))
          throw new CommandError(
            "unavailable",
            "Independent Source is not ready for Workspace Start",
          );
        await hosts.ensureService(state, sql);
        row = await lease(workspaceID, sql);
        if (!row)
          throw new CommandError("unavailable", "Source owner changed before Workspace Start");
        const role = await readSourceWriter(row, sql);
        return sourceStartupConfiguration(
          sql,
          row,
          (operation, body) =>
            this.forward(
              workspaceID,
              null,
              operation,
              new Request("http://source.internal/", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "X-Factory-Writer-Epoch": String(role.epoch),
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(15_000),
              }),
              sql,
            ),
          actorTemplatePath,
        );
      });
    },
    onTransfer(callback: (workspaceID: string) => void) {
      revoke = callback;
    },
    async available(workspaceID: string) {
      // Source remains readable while native compute is starting. Process
      // materialization never occupies the application connection pool.
      const sql = database.coordination();
      let held = false;
      try {
        const [lock] = await sql<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtext(${`source:${workspaceID}`})) AS acquired`;
        if (!lock?.acquired) return false;
        held = true;
        const row = await lease(workspaceID, sql);
        if (row) {
          const state = classifySourceLease(row);
          if (state.owner === "service") {
            await hosts.ensureService(state, sql);
            return true;
          }
        }
        return false;
      } finally {
        try {
          if (held) await sql`SELECT pg_advisory_unlock(hashtext(${`source:${workspaceID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
    async attach(workspaceID: string, actorUID: string, sql: SourceSQL) {
      return withSourceLock(database, workspaceID, sql, async (sql) => {
        const row = await lease(workspaceID, sql);
        if (!row) throw new CommandError("unavailable", "Independent Source was not admitted");
        const state = classifySourceLease(row);
        if (state.owner === "actor" && state.actorUID === actorUID) return;
        // Native allocation is not Source import or permission to execute.
        // Leave the saved tree live until this exact recipient requests it.
        await requireSourceRecipient(state, actorUID, sql);
      });
    },
    async freezeActor(workspaceID: string, attemptID: string, sql: SourceSQL) {
      return withSourceLock(database, workspaceID, sql, async (sql) => {
        const row = await lease(workspaceID, sql);
        const current = row ? classifySourceLease(row) : null;
        if (current?.owner === "service") return;
        if (
          current &&
          (current.phase === "actor-live" || current.phase === "actor-freezing") &&
          !hub.sourceConnected(attemptID)
        )
          throw new CommandError(
            "unavailable",
            "Confirmed independent Source is unavailable; the original Parent was retained.",
          );
        const frozen = await freezeSourceLease(workspaceID, "actor", sql);
        if (frozen.phase === "actor-frozen") return;
        await hub.childOperation(attemptID, {
          operationId: frozen.checkpointID,
          action: "source-drain",
        });
        await hub.parentOperation(attemptID, {
          operationId: frozen.checkpointID,
          action: "source-drain",
          data: frozen.checkpointID,
        });
        await confirmSourceCheckpoint(frozen, attemptID, hosts, objects, sql);
      });
    },
    async makeIndependent(workspaceID: string, sql: SourceSQL) {
      return withSourceLock(database, workspaceID, sql, async (sql) => {
        const row = await lease(workspaceID, sql);
        if (!row) throw new Error("Source owner is missing");
        const state = classifySourceLease(row);
        if (state.owner === "actor") await transferSourceOwner(state, "service", revoke, sql);
        else if (state.phase === "service-freezing" || state.phase === "service-frozen")
          await cancelFrozenServiceImport(workspaceID, state, hosts, revoke, sql);
        const refreshed = await lease(workspaceID, sql);
        if (!refreshed)
          throw new CommandError("unavailable", "Transferred Source owner is missing");
        const current = classifySourceLease(refreshed);
        if (current.owner !== "service")
          throw new CommandError("unavailable", "Independent Source owner is unconfirmed");
        await hosts.ensureService(current, sql);
      });
    },
    async requireIndependent(workspaceID: string, actorUID: string, sql: SourceSQL) {
      return withSourceLock(database, workspaceID, sql, async (sql) => {
        const row = await lease(workspaceID, sql);
        const state = row ? classifySourceLease(row) : null;
        if (
          !state ||
          !isLiveServiceLease(state) ||
          (!(await hasUngrantedStop(workspaceID, actorUID, sql)) &&
            (state.actorUID !== actorUID || !state.checkpoint))
        )
          throw new CommandError(
            "unavailable",
            "Workspace Stop requires confirmed independent Source; the original Actor was retained",
          );
        // A durable ROOTFS is not the independent editable checkout. Confirm its
        // retained materialization and live Source service before deleting it.
        await hosts.ensureService(state, sql);
      });
    },
    async resume(workspaceID: string, attemptID: string, sql: SourceSQL, _inputStop = false) {
      return withSourceLock(database, workspaceID, sql, async (sql) => {
        const current = await lease(workspaceID, sql);
        if (!current) throw new Error("Source owner is missing");
        const state = classifySourceLease(current);
        if (state.phase === "actor-live") return;
        if (state.phase === "actor-freezing" || state.phase === "actor-frozen")
          throw new CommandError("unavailable", "Finish the recorded Source pause before resuming");
        // Only first import or an explicit post-deletion successor consumes
        // independent Source. Ordinary retained-Actor Resume returned above.
        // Publish an unopened seed before freezing: checkpoint/chunk requests
        // must all use its confirmed lease, not re-confirm a stale first read.
        if (state.phase === "seed-pending") await hosts.ensureService(state, sql);
        await confirmSourceCheckpoint(
          await freezeSourceLease(workspaceID, "service", sql),
          attemptID,
          hosts,
          objects,
          sql,
        );
      });
    },
    forward(
      workspaceID: string,
      attemptID: string | null,
      operation: string,
      request: Request,
      sql: SourceSQL,
    ) {
      return forwardSourceRequest(hub, hosts, workspaceID, attemptID, operation, request, sql);
    },
    fence(
      workspaceID: string,
      attemptID: string,
      epoch: string,
      writable: boolean,
      sql: SourceSQL,
      requireLiveRole = false,
    ) {
      return fenceSourceWriter(
        hub,
        hosts,
        workspaceID,
        attemptID,
        epoch,
        writable,
        sql,
        requireLiveRole,
      );
    },
    restoreEndpoint(request: Request, attemptID: string) {
      return handleSourceRestoreEndpoint(
        { database, hosts, objects, revoke: (id) => revoke(id) },
        request,
        attemptID,
      );
    },
    close() {
      return hosts.close();
    },
  };
}
