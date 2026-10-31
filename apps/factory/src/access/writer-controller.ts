import type { createDatabase } from "../../../../packages/db/src/client";
import { forgeUsername } from "../../../../packages/forge/src/access";
import { CommandError } from "../command-error";
import { lockChangeWriterIn } from "./change-writer";
import { projectDevelopmentAuthorityIn } from "./controller";
import { type WriterActivity, writerActivity } from "./writer-activity";

type Database = ReturnType<typeof createDatabase>;
type WriterView = {
  state: string;
  epoch: number;
  canWrite: boolean;
  stopPending: boolean;
  yours: boolean;
  commandID: string | null;
  actor: {
    kind: "human" | "agent";
    user: { id: string; name: string } | null;
    delegated: boolean;
    workState: string | null;
  } | null;
  requester: { id: string; name: string } | null;
  presence: {
    idle: boolean;
    secondsSinceEdit: number | null;
    connected: boolean;
  } | null;
  handoffKind: "takeover" | "release";
  requests: { id: string; requester: { id: string; name: string }; epoch: number }[];
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
  activity?: WriterActivity;
}) {
  const { database } = options;
  const activity = options.activity ?? writerActivity;
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
    if (!attemptID) return true;
    await options.runtime.stop(attemptID);
    const deadline = performance.now() + (options.stopDeadlineMs ?? 45_000);
    for (;;) {
      const state = (await options.runtime.get(attemptID))?.state;
      if (state === "stopped") return true;
      if (performance.now() < deadline) {
        await Bun.sleep(100);
        continue;
      }
      if (state === "stop-intended" || state === "stopping") return false;
      throw new CommandError(
        "conflict",
        "Previous Workspace compute has not stopped. Check its cleanup status before retrying.",
      );
    }
  }
  async function readView(changeID: string, userID: string): Promise<WriterView> {
    return database.client.begin(async (sql) => {
      const writer = await lockChangeWriterIn(sql, changeID);
      await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
      const [actor] = await sql<
        { id: string; name: string; delegated: boolean; workState: string | null }[]
      >`
        SELECT account.id,left(account.name,160) AS name,
          COALESCE(turn.authority ? 'monitoringIncidentId',false) AS delegated,
          turn.state::text AS "workState"
        FROM auth."user" account
        LEFT JOIN factory.agent_turn turn ON turn.id=${writer.turnID}
        WHERE account.id=COALESCE(${writer.userID}::uuid,turn.created_by)`;
      const [requester] = writer.requestedBy
        ? await sql<{ id: string; name: string }[]>`SELECT id,left(name,160) AS name
          FROM auth."user" WHERE id=${writer.requestedBy}`
        : [];
      const [agent] = await sql<{ stopPending: boolean }[]>`
        SELECT stop_pending AS "stopPending" FROM factory.change_agent_session
        WHERE change_id=${changeID}`;
      const stopPending = agent?.stopPending ?? false;
      const presence =
        writer.state === "human" && writer.userID
          ? activity.snapshot(changeID, writer.userID, writer.epoch)
          : null;
      if (writer.state !== "human") activity.clear(changeID);
      const requests =
        writer.state === "human"
          ? await sql<{ id: string; userID: string; name: string; epoch: number }[]>`
          SELECT request.id,account.id AS "userID",left(account.name,160) AS name,
            request.writer_epoch::float8 AS epoch
          FROM factory.change_editing_request request JOIN auth."user" account ON account.id=request.requester_id
          WHERE request.change_id=${changeID} AND request.writer_epoch=${writer.epoch}::bigint
            AND request.state='requested' AND (request.owner_id=${userID} OR request.requester_id=${userID})
          ORDER BY request.created_at,request.id`
          : [];
      return {
        state: writer.state,
        epoch: Number(writer.epoch),
        canWrite: !stopPending && writer.state === "human" && writer.userID === userID,
        stopPending,
        yours: writer.userID === userID || writer.requestedBy === userID,
        commandID: writer.requestedBy === userID ? writer.requestID : null,
        actor: ["human", "agent", "agent-preparing"].includes(writer.state)
          ? {
              kind: writer.state === "human" ? "human" : "agent",
              user: actor ? { id: actor.id, name: actor.name } : null,
              delegated: actor?.delegated ?? false,
              workState: actor?.workState ?? null,
            }
          : null,
        requester: requester ?? null,
        presence,
        handoffKind: writer.handoffKind,
        requests: requests.map((request) => ({
          id: request.id,
          requester: { id: request.userID, name: request.name },
          epoch: request.epoch,
        })),
      };
    });
  }
  return {
    async activity(
      changeID: string,
      userID: string,
      expectedEpoch: number,
      kind: "edit" | "heartbeat",
    ) {
      await database.client.begin(async (sql) => {
        const writer = await lockChangeWriterIn(sql, changeID);
        await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
        if (
          !writer.available ||
          writer.state !== "human" ||
          writer.userID !== userID ||
          writer.epoch !== String(expectedEpoch)
        )
          throw new CommandError(
            "conflict",
            "Editing context changed. Keep your draft and check the current writer.",
          );
        activity.observe(changeID, userID, writer.epoch, kind);
      });
    },
    /** Pure observation: opening the shared chat must never acquire editing. */
    async status(changeID: string, userID: string): Promise<WriterView> {
      return readView(changeID, userID);
    },
    async request(changeID: string, userID: string, commandID: string, expectedEpoch: number) {
      await database.client.begin(async (sql) => {
        const writer = await lockChangeWriterIn(sql, changeID);
        await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
        const [previous] = await sql<{ changeID: string; userID: string; epoch: string }[]>`
          SELECT change_id AS "changeID",requester_id AS "userID",writer_epoch::text AS epoch
          FROM factory.change_editing_request WHERE id=${commandID}`;
        if (previous) {
          if (
            previous.changeID !== changeID ||
            previous.userID !== userID ||
            previous.epoch !== String(expectedEpoch)
          )
            throw new CommandError(
              "conflict",
              "This editing request identity has different input.",
            );
          return;
        }
        if (
          !writer.available ||
          writer.state !== "human" ||
          writer.userID === userID ||
          writer.epoch !== String(expectedEpoch) ||
          !writer.userID
        )
          throw new CommandError(
            "conflict",
            "The writer changed. Check the current editing status.",
          );
        await sql`INSERT INTO factory.change_editing_request(id,change_id,requester_id,owner_id,writer_epoch)
          VALUES(${commandID},${changeID},${userID},${writer.userID},${writer.epoch}::bigint)
          ON CONFLICT (change_id,requester_id,writer_epoch) WHERE state='requested' DO NOTHING`;
      });
      return readView(changeID, userID);
    },
    async approve(
      changeID: string,
      userID: string,
      commandID: string,
      requestID: string,
      expectedEpoch: number,
    ) {
      const [request] = await database.client<{ requesterID: string }[]>`
        SELECT requester_id AS "requesterID" FROM factory.change_editing_request
        WHERE id=${requestID} AND change_id=${changeID} AND owner_id=${userID}`;
      if (!request) throw new CommandError("not-found", "Editing request not found.");
      await this.takeOver(changeID, request.requesterID, commandID, undefined, {
        epoch: expectedEpoch,
        approverID: userID,
        requestID,
      });
      return readView(changeID, userID);
    },
    async takeIdle(changeID: string, userID: string, commandID: string, expectedEpoch: number) {
      return this.takeOver(changeID, userID, commandID, undefined, { epoch: expectedEpoch });
    },
    async release(
      changeID: string,
      userID: string,
      commandID: string,
      expectedEpoch: number,
    ): Promise<WriterView> {
      return exclusive(changeID, async () => {
        const intended = await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
          const [decision] = await sql<
            { actorID: string; epoch: string; changeID: string; kind: string }[]
          >`
            SELECT actor_id AS "actorID",writer_epoch::text AS epoch,change_id AS "changeID",kind
            FROM factory.change_editing_decision WHERE command_id=${commandID}`;
          if (
            decision &&
            (decision.actorID !== userID ||
              decision.changeID !== changeID ||
              decision.epoch !== String(expectedEpoch) ||
              decision.kind !== "release")
          )
            throw new CommandError(
              "conflict",
              "This editing decision identity has different input.",
            );
          if (decision && writer.state !== "handoff") return null;
          if (
            writer.state === "handoff" &&
            writer.handoffKind === "release" &&
            writer.requestedBy === userID &&
            writer.requestID === commandID
          )
            return writer;
          if (
            !writer.available ||
            writer.state !== "human" ||
            writer.userID !== userID ||
            writer.epoch !== String(expectedEpoch)
          )
            throw new CommandError(
              "conflict",
              "The writer changed. Your files have not been discarded.",
            );
          await sql`INSERT INTO factory.change_editing_decision(command_id,change_id,actor_id,writer_epoch,kind)
            VALUES(${commandID},${changeID},${userID},${writer.epoch}::bigint,'release')`;
          await sql`UPDATE factory.change_writer SET state='handoff',handoff_kind='release',
            epoch=epoch+1,user_id=NULL,turn_id=NULL,requested_by=${userID},request_id=${commandID},
            fence_required=true,fence_attempt_id=(SELECT runtime_attempt_id FROM factory.change WHERE id=${changeID}),
            updated_at=now() WHERE change_id=${changeID}`;
          return lockChangeWriterIn(sql, changeID);
        });
        if (!intended) return readView(changeID, userID);
        await options.fenceSource?.(changeID, intended.epoch, false);
        await options.protect(changeID, []);
        if (!(await stopped(intended.fenceAttemptID)))
          throw new CommandError(
            "conflict",
            "Release saved. Previous commands have not stopped yet. Check editing status to continue.",
          );
        await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          if (
            writer.state !== "handoff" ||
            writer.epoch !== intended.epoch ||
            writer.handoffKind !== "release" ||
            writer.requestID !== commandID
          )
            throw new CommandError("conflict", "Editing release changed before confirmation.");
          await sql`UPDATE factory.change_writer SET state='unassigned',epoch=epoch+1,
            requested_by=NULL,request_id=NULL,fence_required=false,updated_at=now()
            WHERE change_id=${changeID}`;
          await sql`UPDATE factory.change_editing_request SET state='superseded',decided_at=now()
            WHERE change_id=${changeID} AND state='requested'`;
        });
        activity.clear(changeID);
        return readView(changeID, userID);
      });
    },
    async view(changeID: string, userID: string): Promise<WriterView> {
      // An open editor keeps observing after Coding settles. That read must not
      // commission a human takeover and silently block exact-commit Verification.
      // Only already recorded human decisions may continue here.
      const [pending] = await database.client<{ commandID: string }[]>`
        SELECT writer.request_id AS "commandID" FROM factory.change_writer writer
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id=writer.fence_attempt_id
        WHERE writer.change_id=${changeID} AND writer.state='handoff' AND writer.handoff_kind='takeover'
          AND writer.requested_by=${userID} AND writer.request_id IS NOT NULL
          AND (writer.fence_attempt_id IS NULL OR attempt.state='stopped')`;
      // Continue only the same person's recorded request after positive teardown
      // evidence. Takeover rechecks permissions, Stop, source and branch fences.
      if (pending) return this.takeOver(changeID, userID, pending.commandID);
      const [release] = await database.client<{ commandID: string; epoch: number }[]>`
        SELECT writer.request_id AS "commandID",decision.writer_epoch::float8 AS epoch
        FROM factory.change_writer writer
        JOIN factory.change_editing_decision decision ON decision.command_id=writer.request_id
          AND decision.change_id=writer.change_id AND decision.actor_id=writer.requested_by
          AND decision.kind='release' AND decision.writer_epoch+1=writer.epoch
        WHERE writer.change_id=${changeID} AND writer.state='handoff'
          AND writer.handoff_kind='release' AND writer.requested_by=${userID}`;
      // Reconcile the already commissioned release, not a new editing command.
      // The exact decision rechecks authority and all fences after transport loss.
      if (release) return this.release(changeID, userID, release.commandID, release.epoch);
      return readView(changeID, userID);
    },
    async prepareAgent(changeID: string, turnID: string) {
      return exclusive(changeID, async () => {
        const writer = await database.client.begin((sql) => lockChangeWriterIn(sql, changeID));
        if (writer.turnID !== turnID || !["agent-preparing", "agent"].includes(writer.state))
          throw new CommandError("conflict", "Agent writing authority changed before execution");
        if (writer.state === "agent") return true;
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
        if (writer.fenceRequired && !(await stopped(writer.fenceAttemptID))) return false;
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
        return true;
      });
    },
    async takeOver(
      changeID: string,
      userID: string,
      commandID: string,
      completedEpoch?: string,
      humanTransfer?: { epoch: number; approverID?: string; requestID?: string },
      observedEpoch?: number,
    ): Promise<WriterView> {
      return exclusive(changeID, async () => {
        const intended = await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
          const continuing =
            writer.state === "handoff" &&
            writer.handoffKind === "takeover" &&
            writer.requestedBy === userID &&
            writer.requestID === commandID;
          if (observedEpoch !== undefined && writer.epoch !== String(observedEpoch) && !continuing)
            throw new CommandError(
              "conflict",
              "The writer changed. Check the current editing status before taking over.",
            );
          if (humanTransfer && writer.state !== "human" && !continuing)
            throw new CommandError(
              "conflict",
              "Idle takeover applies only to the observed human writer. Agent and unconfirmed work must use explicit Stop.",
            );
          if (humanTransfer && continuing) {
            const [decision] = await sql`SELECT command_id FROM factory.change_editing_decision
              WHERE command_id=${commandID} AND change_id=${changeID} AND target_id=${userID}
                AND actor_id=${humanTransfer.approverID ?? userID} AND writer_epoch=${humanTransfer.epoch}::bigint
                AND kind=${humanTransfer.approverID ? "approve" : "idle-takeover"}
                AND request_id IS NOT DISTINCT FROM ${humanTransfer.requestID ?? null}`;
            if (!decision)
              throw new CommandError("conflict", "The editing decision changed input.");
          }
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
            let authorizedTransfer = false;
            if (humanTransfer && writer.epoch === String(humanTransfer.epoch) && writer.userID) {
              if (humanTransfer.approverID && humanTransfer.requestID) {
                await projectDevelopmentAuthorityIn(
                  sql,
                  humanTransfer.approverID,
                  writer.projectID,
                );
                const [request] = await sql`SELECT id FROM factory.change_editing_request
                  WHERE id=${humanTransfer.requestID} AND change_id=${changeID}
                    AND requester_id=${userID} AND owner_id=${humanTransfer.approverID}
                    AND owner_id=${writer.userID} AND writer_epoch=${writer.epoch}::bigint AND state='requested'
                  FOR UPDATE`;
                if (!request)
                  throw new CommandError("conflict", "This editing request is no longer current.");
                authorizedTransfer = true;
              } else {
                authorizedTransfer = activity.snapshot(changeID, writer.userID, writer.epoch).idle;
              }
            }
            if (humanTransfer && !authorizedTransfer)
              throw new CommandError(
                "conflict",
                "The writer is active or changed. Request editing instead.",
              );
            if (authorizedTransfer) {
              const kind = humanTransfer?.approverID ? "approve" : "idle-takeover";
              await sql`INSERT INTO factory.change_editing_decision(command_id,change_id,actor_id,target_id,writer_epoch,kind,request_id)
                VALUES(${commandID},${changeID},${humanTransfer?.approverID ?? userID},${userID},
                  ${writer.epoch}::bigint,${kind},${humanTransfer?.requestID ?? null})`;
              if (humanTransfer?.requestID)
                await sql`UPDATE factory.change_editing_request SET state='accepted',
                  decided_by=${humanTransfer.approverID ?? userID},decided_at=now() WHERE id=${humanTransfer.requestID}`;
            }
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
            if (current && !authorizedTransfer)
              throw new CommandError(
                "conflict",
                "Another developer is editing this implementation",
              );
          }
          if (writer.state === "handoff") {
            if (
              writer.handoffKind === "takeover" &&
              writer.requestedBy === userID &&
              writer.requestID === commandID
            )
              return writer;
            try {
              if (!writer.requestedBy) throw new Error("Takeover identity is unavailable");
              await projectDevelopmentAuthorityIn(sql, writer.requestedBy, writer.projectID);
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              await sql`INSERT INTO factory.change_editing_decision(command_id,change_id,actor_id,target_id,writer_epoch,kind)
                VALUES(${commandID},${changeID},${userID},${userID},${writer.epoch}::bigint,'takeover')`;
              await sql`UPDATE factory.change_writer SET requested_by=${userID},request_id=${commandID},
                handoff_kind='takeover',epoch=epoch+1,updated_at=now() WHERE change_id=${changeID}`;
              return lockChangeWriterIn(sql, changeID);
            }
            throw new CommandError("conflict", "An editing takeover is already in progress");
          }
          await sql`UPDATE factory.monitoring_incident incident SET state='blocked',
            reason='A developer took over source editing. Automatic Delivery is disabled.',settled_at=now()
            FROM factory.change change WHERE change.id=${changeID} AND incident.ticket_id=change.ticket_id
              AND incident.state='implementing'`;
          if (!humanTransfer)
            await sql`INSERT INTO factory.change_editing_decision(command_id,change_id,actor_id,target_id,writer_epoch,kind)
              VALUES(${commandID},${changeID},${userID},${userID},${writer.epoch}::bigint,'takeover')`;
          await sql`UPDATE factory.change_writer SET state='handoff',handoff_kind='takeover',user_id=NULL,turn_id=NULL,
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
        const [unsubmittedFailure] = await database.client`SELECT session.change_id
          FROM factory.change_agent_session session
          JOIN factory.change change ON change.id=session.change_id
          JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
          WHERE session.change_id=${changeID} AND session.state='stopped' AND session.stop_pending
            AND session.native_session_confirmed_at IS NULL
            AND session.implementation_session_confirmed_at IS NULL
            AND session.runtime_attempt_id=${intended.fenceAttemptID}
            AND change.runtime_attempt_id=session.runtime_attempt_id
            AND attempt.state IN ('failed','cleanup-failed')
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
              JOIN factory.agent_turn turn ON turn.id=intent.turn_id
              WHERE turn.change_id=session.change_id AND intent.runtime_attempt_id=session.runtime_attempt_id
                AND (intent.bootstrap IS DISTINCT FROM true
                  OR intent.session_id IS DISTINCT FROM session.opencode_session_id))
            AND NOT EXISTS(SELECT 1 FROM factory.agent_turn
              WHERE change_id=session.change_id AND state IN ('pending','dispatching','running','uncertain'))
            AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation
              WHERE change_id=session.change_id AND state NOT IN ('succeeded','failed'))`;
        if (unsubmittedFailure) {
          // Stop has already fenced late native confirmation and all prompts.
          // A failed bootstrap cannot supply live OpenCode history. Confirm
          // exact compute teardown first, then let the ordinary Stop verifier
          // settle it. Confirmed/reused Sessions never take this path.
          if (!(await stopped(intended.fenceAttemptID)))
            throw new CommandError(
              "conflict",
              "Stopping failed startup compute before editing takeover. Its original identity is retained.",
            );
          await options.stopAgent(changeID);
        }
        const [unsettled] =
          await database.client`SELECT change_id FROM factory.change_agent_session WHERE change_id=${changeID} AND stop_pending
        UNION ALL SELECT change_id FROM factory.agent_turn WHERE change_id=${changeID} AND state IN ('pending','dispatching','running','uncertain')
        UNION ALL SELECT change_id FROM factory.change_commit_operation WHERE change_id=${changeID} AND state NOT IN ('succeeded','failed')`;
        if (unsettled)
          throw new CommandError(
            "conflict",
            "Waiting for confirmed Agent Stop before editing takeover",
          );
        if (!(await stopped(intended.fenceAttemptID)))
          throw new CommandError(
            "conflict",
            "Stopping previous commands. Retry editing takeover when compute has stopped.",
          );
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
          await sql`UPDATE factory.change_editing_request SET state='superseded',decided_at=now()
            WHERE change_id=${changeID} AND state='requested'`;
        });
        return readView(changeID, userID);
      });
    },
  };
}
