import { eq, sql as expression } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { change, changeWriter, developmentWorkspace, substrateSource, ticket } from "#db/schema";
import { CommandError } from "../command-error";
import { type InitialSourceSeed, initialSourceSeed } from "./source-initialization";
import { type SourceCheckpoint, sourceCheckpoint } from "./substrate-source-checkpoints";

export type SourceDatabase = ReturnType<typeof createDatabase>;
export type SourceSQL = SourceDatabase["client"] | DatabaseTransaction;

export type SubstrateSourceLeaseRow = {
  workspaceID: string;
  actorUID: string | null;
  owner: "actor" | "service";
  writerEpoch: number;
  writable: boolean;
  generation: number;
  checkpointID: string | null;
  checkpoint: SourceCheckpoint | null;
  serviceBase: string | null;
  seed: InitialSourceSeed | null;
  seedConfirmedAt: Date | null;
};

export type SourceLeasePhase =
  | "seed-pending"
  | "seed-ready"
  | "service-live"
  | "service-freezing"
  | "service-frozen"
  | "actor-live"
  | "actor-freezing"
  | "actor-frozen";

export type SeedPendingSourceLease = SubstrateSourceLeaseRow & {
  phase: "seed-pending";
  owner: "service";
  writable: true;
  serviceBase: string;
  seed: InitialSourceSeed;
  seedConfirmedAt: null;
  checkpointID: null;
};
export type SeedReadySourceLease = SubstrateSourceLeaseRow & {
  phase: "seed-ready";
  owner: "service";
  writable: true;
  serviceBase: string;
  seed: InitialSourceSeed;
  seedConfirmedAt: Date;
  checkpointID: null;
};
export type ServiceLiveSourceLease = SubstrateSourceLeaseRow & {
  phase: "service-live";
  owner: "service";
  writable: true;
  serviceBase: string;
  checkpointID: null;
};
export type ServiceFreezingSourceLease = SubstrateSourceLeaseRow & {
  phase: "service-freezing";
  owner: "service";
  writable: false;
  serviceBase: string;
  checkpointID: string;
};
export type ServiceFrozenSourceLease = SubstrateSourceLeaseRow & {
  phase: "service-frozen";
  owner: "service";
  writable: false;
  serviceBase: string;
  checkpointID: string;
  checkpoint: SourceCheckpoint;
};
export type ActorLiveSourceLease = SubstrateSourceLeaseRow & {
  phase: "actor-live";
  owner: "actor";
  writable: true;
  actorUID: string;
  checkpointID: null;
};
export type ActorFreezingSourceLease = SubstrateSourceLeaseRow & {
  phase: "actor-freezing";
  owner: "actor";
  writable: false;
  actorUID: string;
  checkpointID: string;
};
export type ActorFrozenSourceLease = SubstrateSourceLeaseRow & {
  phase: "actor-frozen";
  owner: "actor";
  writable: false;
  actorUID: string;
  checkpointID: string;
  checkpoint: SourceCheckpoint;
};

export type ServiceSourceLease =
  | SeedPendingSourceLease
  | SeedReadySourceLease
  | ServiceLiveSourceLease
  | ServiceFreezingSourceLease
  | ServiceFrozenSourceLease;

export type ActorSourceLease =
  | ActorLiveSourceLease
  | ActorFreezingSourceLease
  | ActorFrozenSourceLease;

export type LiveServiceSourceLease =
  | SeedPendingSourceLease
  | SeedReadySourceLease
  | ServiceLiveSourceLease;

export type NonWritableSourceLease =
  | ServiceFreezingSourceLease
  | ServiceFrozenSourceLease
  | ActorFreezingSourceLease
  | ActorFrozenSourceLease;

export type FrozenSourceLease = ServiceFrozenSourceLease | ActorFrozenSourceLease;
export type ClassifiedSourceLease = ServiceSourceLease | ActorSourceLease;

export function classifySourceLease(row: SubstrateSourceLeaseRow): ClassifiedSourceLease {
  if (row.owner === "service") {
    if (!row.serviceBase)
      throw new CommandError("unavailable", "Independent Source owner is unconfirmed");
    if (row.writable) {
      if (row.checkpointID !== null)
        throw new CommandError("conflict", "Source freeze is unconfirmed");
      if (row.seed && row.serviceBase === row.seed.id) {
        if (row.seedConfirmedAt === null)
          return {
            ...row,
            phase: "seed-pending",
            owner: "service",
            writable: true,
            serviceBase: row.serviceBase,
            seed: row.seed,
            seedConfirmedAt: null,
            checkpointID: null,
          };
        return {
          ...row,
          phase: "seed-ready",
          owner: "service",
          writable: true,
          serviceBase: row.serviceBase,
          seed: row.seed,
          seedConfirmedAt: row.seedConfirmedAt,
          checkpointID: null,
        };
      }
      return {
        ...row,
        phase: "service-live",
        owner: "service",
        writable: true,
        serviceBase: row.serviceBase,
        checkpointID: null,
      };
    }
    if (!row.checkpointID) throw new CommandError("conflict", "Source freeze is unconfirmed");
    if (row.checkpoint?.id === row.checkpointID)
      return {
        ...row,
        phase: "service-frozen",
        owner: "service",
        writable: false,
        serviceBase: row.serviceBase,
        checkpointID: row.checkpointID,
        checkpoint: row.checkpoint,
      };
    return {
      ...row,
      phase: "service-freezing",
      owner: "service",
      writable: false,
      serviceBase: row.serviceBase,
      checkpointID: row.checkpointID,
    };
  }
  if (!row.actorUID) throw new CommandError("conflict", "Source owner changed");
  if (row.writable) {
    if (row.checkpointID !== null)
      throw new CommandError("conflict", "Source freeze is unconfirmed");
    return {
      ...row,
      phase: "actor-live",
      owner: "actor",
      writable: true,
      actorUID: row.actorUID,
      checkpointID: null,
    };
  }
  if (!row.checkpointID) throw new CommandError("conflict", "Source freeze is unconfirmed");
  if (row.checkpoint?.id === row.checkpointID)
    return {
      ...row,
      phase: "actor-frozen",
      owner: "actor",
      writable: false,
      actorUID: row.actorUID,
      checkpointID: row.checkpointID,
      checkpoint: row.checkpoint,
    };
  return {
    ...row,
    phase: "actor-freezing",
    owner: "actor",
    writable: false,
    actorUID: row.actorUID,
    checkpointID: row.checkpointID,
  };
}

export function isLiveServiceLease(lease: ClassifiedSourceLease): lease is LiveServiceSourceLease {
  return (
    lease.phase === "seed-pending" || lease.phase === "seed-ready" || lease.phase === "service-live"
  );
}

export function isFrozenLease(lease: ClassifiedSourceLease): lease is FrozenSourceLease {
  return lease.phase === "service-frozen" || lease.phase === "actor-frozen";
}

export async function withSourceLock<T>(
  database: SourceDatabase,
  workspaceID: string,
  sql: SourceSQL,
  action: (sql: SourceSQL) => Promise<T>,
): Promise<T> {
  if ("savepoint" in sql)
    return sql.savepoint(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`source:${workspaceID}`}))`;
      return action(tx);
    });
  // Freeze and object publication are durable facts even if a later external
  // reply is lost. A session lock serializes them without rolling them back.
  const owner = database.coordination();
  try {
    await owner`SELECT pg_advisory_lock(hashtext(${`source:${workspaceID}`}))`;
    return await action(owner);
  } finally {
    try {
      await owner`SELECT pg_advisory_unlock(hashtext(${`source:${workspaceID}`}))`;
    } finally {
      await owner.end({ timeout: 1 });
    }
  }
}

export async function readSourceLease(
  workspaceID: string,
  sql: SourceSQL,
): Promise<SubstrateSourceLeaseRow | null> {
  const [row] = await drizzleTransaction(sql)
    .select({
      workspaceID: substrateSource.workspaceId,
      actorUID: substrateSource.actorUid,
      owner: expression<SubstrateSourceLeaseRow["owner"]>`${substrateSource.owner}`,
      writerEpoch: substrateSource.writerEpoch,
      writable: substrateSource.writable,
      generation: substrateSource.generation,
      checkpointID: substrateSource.checkpointId,
      checkpoint: substrateSource.checkpoint,
      serviceBase: substrateSource.serviceBase,
      seed: substrateSource.seed,
      seedConfirmedAt: substrateSource.seedConfirmedAt,
    })
    .from(substrateSource)
    .where(eq(substrateSource.workspaceId, workspaceID));
  return row
    ? {
        ...row,
        checkpoint: row.checkpoint ? sourceCheckpoint.parse(row.checkpoint) : null,
        seed: row.seed ? initialSourceSeed.parse(row.seed) : null,
      }
    : null;
}

export async function readSourceWriter(row: SubstrateSourceLeaseRow, sql: SourceSQL) {
  const [workspace] = await drizzleTransaction(sql)
    .select({
      kind: developmentWorkspace.kind,
      epoch: changeWriter.epoch,
      writable: expression<boolean | null>`(${changeWriter.state}='human'
        AND ${change.state} IN ('starting','active','failed')
        AND ${change.cancelRequestedAt} IS NULL AND ${ticket.trashedAt} IS NULL)`,
    })
    .from(developmentWorkspace)
    .leftJoin(changeWriter, eq(changeWriter.changeId, developmentWorkspace.changeId))
    .leftJoin(change, eq(change.id, developmentWorkspace.changeId))
    .leftJoin(ticket, eq(ticket.id, developmentWorkspace.ticketId))
    .where(eq(developmentWorkspace.id, row.workspaceID));
  if (!workspace || (workspace.kind !== "personal" && !workspace.epoch))
    throw new CommandError("unavailable", "Current Source writing authority is unavailable");
  return {
    epoch: workspace.epoch ?? row.writerEpoch,
    writable: row.writable && (workspace.kind === "personal" || workspace.writable === true),
  };
}
