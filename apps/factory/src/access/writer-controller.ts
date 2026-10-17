import type { createDatabase } from "../../../../packages/db/src/client";
import { forgeUsername } from "../../../../packages/forge/src/access";
import { CommandError } from "../command-error";
import { lockChangeWriterIn } from "./change-writer";
import { projectDevelopmentAuthorityIn } from "./controller";

type Database = ReturnType<typeof createDatabase>;
type WriterView = {
  state: string;
  epoch: number;
  canWrite: boolean;
  yours: boolean;
  commandID: string | null;
};
type RuntimeBoundary = {
  stop(attemptID: string): Promise<unknown>;
  get(attemptID: string): Promise<{ state: string } | null>;
};
export function createChangeWriterController(options: {
  database: Database;
  runtime: RuntimeBoundary;
  stopAgent(changeID: string): Promise<unknown>;
  protect(changeID: string, writers: readonly string[]): Promise<void>;
  fenceSource?(changeID: string, epoch: string, writable: boolean): Promise<void>;
  agentUsername: string;
  stopDeadlineMs?: number;
}) {
  const { database } = options;
  async function exclusive<T>(changeID: string, work: () => Promise<T>): Promise<T> {
    const connection = database.coordination();
    const key = `change-writer-operation:${changeID}`;
    try {
      await connection`SELECT pg_advisory_lock(hashtext(${key}))`;
      return await work();
    } finally {
      try {
        await connection`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        await connection.end({ timeout: 1 });
      }
    }
  }
  async function stopped(attemptID: string | null) {
    if (!attemptID) return;
    await options.runtime.stop(attemptID);
    const deadline = performance.now() + (options.stopDeadlineMs ?? 45_000);
    while ((await options.runtime.get(attemptID))?.state !== "stopped") {
      if (performance.now() < deadline) {
        await Bun.sleep(100);
        continue;
      }
      throw new CommandError(
        "conflict",
        "Stopping previous commands. Retry editing takeover when compute has stopped.",
      );
    }
  }
  async function readView(changeID: string, userID: string): Promise<WriterView> {
    return database.client.begin(async (sql) => {
      const writer = await lockChangeWriterIn(sql, changeID);
      await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
      return {
        state: writer.state,
        epoch: Number(writer.epoch),
        canWrite: writer.state === "human" && writer.userID === userID,
        yours: writer.userID === userID || writer.requestedBy === userID,
        commandID: writer.requestedBy === userID ? writer.requestID : null,
      };
    });
  }
  return {
    async view(changeID: string, userID: string): Promise<WriterView> {
      const [finished] = await database.client<
        { epoch: string }[]
      >`SELECT writer.epoch::text FROM factory.change_writer writer
        JOIN factory.change_agent_session session ON session.change_id=writer.change_id
        WHERE writer.change_id=${changeID} AND writer.state='agent'
          AND session.state IN ('committed','stopped') AND NOT session.stop_pending
          AND EXISTS(SELECT 1 FROM factory.agent_turn WHERE id=writer.turn_id AND state IN ('completed','stopped','failed'))
          AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${changeID} AND state IN ('pending','dispatching','running','uncertain'))
          AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=${changeID} AND state NOT IN ('succeeded','failed'))`;
      // Settled work needs no explicit Stop. The first authorized developer
      // receives editing after the same process and Git fence as early takeover.
      if (finished) return this.takeOver(changeID, userID, crypto.randomUUID(), finished.epoch);
      const [pending] = await database.client<{ commandID: string }[]>`
        SELECT writer.request_id AS "commandID" FROM factory.change_writer writer
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id=writer.fence_attempt_id
        WHERE writer.change_id=${changeID} AND writer.state='handoff'
          AND writer.requested_by=${userID} AND writer.request_id IS NOT NULL
          AND (writer.fence_attempt_id IS NULL OR attempt.state='stopped')`;
      // Continue only the same person's recorded request after positive teardown
      // evidence. Takeover rechecks permissions, Stop, source and branch fences.
      if (pending) return this.takeOver(changeID, userID, pending.commandID);
      return readView(changeID, userID);
    },
    async prepareAgent(changeID: string, turnID: string) {
      return exclusive(changeID, async () => {
        const writer = await database.client.begin((sql) => lockChangeWriterIn(sql, changeID));
        if (writer.turnID !== turnID || !["agent-preparing", "agent"].includes(writer.state))
          throw new CommandError("conflict", "Agent writing authority changed before execution");
        if (writer.state === "agent") return;
        // An old interactive shell can retain child jobs, Docker execs and services.
        // Confirm full compute teardown rather than pretending shell-PID kill fences it.
        await database.client.begin(async (sql) => {
          const current = await lockChangeWriterIn(sql, changeID);
          if (
            current.state !== "agent-preparing" ||
            current.epoch !== writer.epoch ||
            current.turnID !== turnID
          )
            throw new CommandError("conflict", "Agent writer changed before fencing");
          await options.fenceSource?.(changeID, current.epoch, false);
          await options.protect(changeID, []);
        });
        if (writer.fenceRequired) await stopped(writer.fenceAttemptID);
        await database.client.begin(async (sql) => {
          const current = await lockChangeWriterIn(sql, changeID);
          if (
            current.state !== "agent-preparing" ||
            current.epoch !== writer.epoch ||
            current.turnID !== turnID ||
            !current.available
          )
            throw new CommandError(
              "conflict",
              "Agent writing authority changed during preparation",
            );
          await options.protect(changeID, [options.agentUsername]);
          await sql`UPDATE factory.change_writer SET state='agent',fence_required=false,updated_at=now() WHERE change_id=${changeID}`;
        });
      });
    },
    async takeOver(
      changeID: string,
      userID: string,
      commandID: string,
      completedEpoch?: string,
    ): Promise<WriterView> {
      return exclusive(changeID, async () => {
        const intended = await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
          if (completedEpoch) {
            const [settled] = await sql`SELECT change_id FROM factory.change_agent_session
              WHERE change_id=${changeID} AND state IN ('committed','stopped') AND NOT stop_pending
                AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${changeID} AND state IN ('pending','dispatching','running','uncertain'))
                AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=${changeID} AND state NOT IN ('succeeded','failed'))`;
            if (writer.state !== "agent" || writer.epoch !== completedEpoch || !settled)
              return null;
          }
          if (!writer.available)
            throw new CommandError("conflict", "This implementation is no longer active");
          if (writer.state === "human") {
            if (writer.userID === userID) return null;
            try {
              if (!writer.userID) throw new Error("Human writer identity is unavailable");
              await projectDevelopmentAuthorityIn(sql, writer.userID, writer.projectID);
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              // Revoked writers cannot strand retained Project work indefinitely.
              await sql`UPDATE factory.change_writer SET state='unassigned',user_id=NULL WHERE change_id=${changeID}`;
            }
            const [current] =
              await sql`SELECT change_id FROM factory.change_writer WHERE change_id=${changeID} AND state='human'`;
            if (current)
              throw new CommandError(
                "conflict",
                "Another developer is editing this implementation",
              );
          }
          if (writer.state === "handoff") {
            if (writer.requestedBy === userID && writer.requestID === commandID) return writer;
            try {
              if (!writer.requestedBy) throw new Error("Takeover identity is unavailable");
              await projectDevelopmentAuthorityIn(sql, writer.requestedBy, writer.projectID);
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              await sql`UPDATE factory.change_writer SET requested_by=${userID},request_id=${commandID},epoch=epoch+1,updated_at=now() WHERE change_id=${changeID}`;
              return lockChangeWriterIn(sql, changeID);
            }
            throw new CommandError("conflict", "An editing takeover is already in progress");
          }
          await sql`UPDATE factory.change_writer SET state='handoff',user_id=NULL,turn_id=NULL,
          epoch=epoch+1,requested_by=${userID},request_id=${commandID},fence_required=true,
          fence_attempt_id=(SELECT runtime_attempt_id FROM factory.change WHERE id=${changeID}),updated_at=now()
          WHERE change_id=${changeID}`;
          return lockChangeWriterIn(sql, changeID);
        });
        if (!intended) return readView(changeID, userID);
        await options.fenceSource?.(changeID, intended.epoch, false);
        await database.client.begin(async (sql) => {
          const current = await lockChangeWriterIn(sql, changeID);
          if (
            current.state !== "handoff" ||
            current.epoch !== intended.epoch ||
            current.requestID !== commandID
          )
            throw new CommandError("conflict", "Editing takeover changed before fencing");
          await options.protect(changeID, []);
        });
        const [running] =
          await database.client`SELECT change_id FROM factory.change_agent_session WHERE change_id=${changeID}
        AND (stop_pending OR state IN ('starting','working','failed'))
        UNION ALL SELECT change_id FROM factory.agent_turn WHERE change_id=${changeID} AND state IN ('pending','dispatching','running','uncertain')`;
        if (running) await options.stopAgent(changeID);
        const [unsettled] =
          await database.client`SELECT change_id FROM factory.change_agent_session WHERE change_id=${changeID} AND stop_pending
        UNION ALL SELECT change_id FROM factory.agent_turn WHERE change_id=${changeID} AND state IN ('pending','dispatching','running','uncertain')
        UNION ALL SELECT change_id FROM factory.change_commit_operation WHERE change_id=${changeID} AND state NOT IN ('succeeded','failed')`;
        if (unsettled)
          throw new CommandError(
            "conflict",
            "Waiting for confirmed Agent Stop before editing takeover",
          );
        await stopped(intended.fenceAttemptID);
        await database.client.begin(async (sql) => {
          const current = await lockChangeWriterIn(sql, changeID);
          await projectDevelopmentAuthorityIn(sql, userID, current.projectID);
          if (
            current.state !== "handoff" ||
            current.epoch !== intended.epoch ||
            current.requestedBy !== userID ||
            current.requestID !== commandID ||
            !current.available
          )
            throw new CommandError("conflict", "Editing takeover changed before confirmation");
          // Keep the policy lock through external branch confirmation. No new Agent
          // admission or revocation may slip between the grant and publication.
          await options.protect(changeID, [forgeUsername(userID)]);
          // Persist the new human epoch before enabling source writes. The first
          // authorized save confirms it, including after a lost acknowledgement.
          await sql`UPDATE factory.change_writer SET state='human',epoch=epoch+1,user_id=${userID},requested_by=NULL,request_id=NULL,
          fence_required=false,updated_at=now() WHERE change_id=${changeID}`;
        });
        return readView(changeID, userID);
      });
    },
  };
}
