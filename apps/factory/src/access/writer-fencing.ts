import { and, eq, inArray, notExists, notInArray, or, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, changeAgentSession, changeCommitOperation, changeWriter } from "#db/schema";
import type { PendingWriterHandoff } from "../agent/runtime-api";
import type { createAgentTurnStore } from "../agent/turns-api";
import { CommandError } from "../command-error";
import { retainedSourcePreparationIn } from "../workspace/source-role-fence";
import { lockChangeWriterIn } from "./change-writer";
import {
  ACTIVE_AGENT_TURN_STATES,
  SETTLED_COMMIT_STATES,
  type WriterContext,
  type WriterDatabase,
  type WriterRuntimeBoundary,
  type WriterTransactionDB,
  withExclusiveWriter,
} from "./writer-decisions";

type AgentTurnStore = ReturnType<typeof createAgentTurnStore>;

export async function awaitRuntimeStopped(
  runtime: WriterRuntimeBoundary,
  stopDeadlineMs: number | undefined,
  attemptID: string | null,
  handoff?: PendingWriterHandoff,
) {
  if (!attemptID) return true;
  await runtime.stop(attemptID, handoff);
  const deadline = performance.now() + (stopDeadlineMs ?? 45_000);
  for (;;) {
    const attempt = await runtime.get(attemptID);
    const state = attempt?.state;
    if (state === "stopped") return true;
    // Product native Stop retains the original Actor and private Docker data.
    // Only the independently observed durable ROOTFS + released Source owner
    // fences its compute; a generic paused row is not teardown evidence. Agent
    // queued-input settlement remains a separate prerequisite below.
    if (
      state === "paused" &&
      attempt?.native?.engine === "substrate" &&
      attempt.native.state === "ACTOR_STATE_SUSPENDED" &&
      attempt.native.sourceHandoff === "confirmed-same-node"
    )
      return true;
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

function activeAgentTurnsForChange(db: WriterDatabase["db"], changeID: string) {
  return db
    .select({ changeID: query<string>`${agentTurn.changeId}` })
    .from(agentTurn)
    .where(
      and(eq(agentTurn.changeId, changeID), inArray(agentTurn.state, ACTIVE_AGENT_TURN_STATES)),
    );
}

export async function isAgentSessionSettledIn(db: WriterTransactionDB, changeID: string) {
  const [settled] = await db
    .select({ changeID: changeAgentSession.changeId })
    .from(changeAgentSession)
    .where(
      and(
        eq(changeAgentSession.changeId, changeID),
        inArray(changeAgentSession.state, ["committed", "stopped"]),
        eq(changeAgentSession.stopPending, false),
        notExists(
          db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, changeID),
                inArray(agentTurn.state, ACTIVE_AGENT_TURN_STATES),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: changeCommitOperation.id })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, changeID),
                notInArray(changeCommitOperation.state, SETTLED_COMMIT_STATES),
              ),
            ),
        ),
      ),
    );
  return Boolean(settled);
}

export async function fenceAgentForTakeover(
  context: WriterContext,
  changeID: string,
  fenceAttemptID: string | null,
) {
  const { database } = context;
  const [running] = await database.db
    .select({ changeID: changeAgentSession.changeId })
    .from(changeAgentSession)
    .where(
      and(
        eq(changeAgentSession.changeId, changeID),
        or(
          changeAgentSession.stopPending,
          inArray(changeAgentSession.state, ["starting", "working", "failed"]),
        ),
      ),
    )
    .unionAll(activeAgentTurnsForChange(database.db, changeID));
  if (running) await context.stopAgent(changeID);
  const [unsubmittedFailure] = await database.client`SELECT session.change_id
    FROM factory.change_agent_session session
    JOIN factory.change change ON change.id=session.change_id
    JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
    WHERE session.change_id=${changeID} AND session.state='stopped' AND session.stop_pending
      AND session.native_session_confirmed_at IS NULL
      AND session.implementation_session_confirmed_at IS NULL
      AND session.runtime_attempt_id=${fenceAttemptID}
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
    if (!(await awaitRuntimeStopped(context.runtime, context.stopDeadlineMs, fenceAttemptID)))
      throw new CommandError(
        "conflict",
        "Stopping failed startup compute before editing takeover. Its original identity is retained.",
      );
    await context.stopAgent(changeID);
  }
  const [unsettled] = await database.db
    .select({ changeID: changeAgentSession.changeId })
    .from(changeAgentSession)
    .where(and(eq(changeAgentSession.changeId, changeID), changeAgentSession.stopPending))
    .unionAll(activeAgentTurnsForChange(database.db, changeID))
    .unionAll(
      database.db
        .select({ changeID: changeCommitOperation.changeId })
        .from(changeCommitOperation)
        .where(
          and(
            eq(changeCommitOperation.changeId, changeID),
            notInArray(changeCommitOperation.state, SETTLED_COMMIT_STATES),
          ),
        ),
    );
  if (unsettled)
    throw new CommandError("conflict", "Waiting for confirmed Agent Stop before editing takeover");
  if (!(await awaitRuntimeStopped(context.runtime, context.stopDeadlineMs, fenceAttemptID)))
    throw new CommandError(
      "conflict",
      "Stopping previous commands. Retry editing takeover when compute has stopped.",
    );
}

export async function prepareAgentWriter(
  context: WriterContext,
  turns: AgentTurnStore,
  changeID: string,
  turnID: string,
  ownerToken?: string,
) {
  const { database } = context;
  return withExclusiveWriter(database, changeID, async () => {
    const writer = await database.client.begin((sql) => lockChangeWriterIn(sql, changeID));
    if (writer.turnID !== turnID || !["agent-preparing", "agent"].includes(writer.state))
      throw new CommandError("conflict", "Agent writing authority changed before execution");
    if (writer.state === "agent") return true;
    if (ownerToken && !writer.fenceRequired && writer.fenceAttemptID) {
      const attemptID = writer.fenceAttemptID;
      const retained = await database.client.begin(async (sql) => {
        if (!(await turns.validateExecutionIn(sql, turnID, ownerToken))) return null;
        const candidate = await retainedSourcePreparationIn(sql, attemptID);
        return candidate?.changeID === changeID &&
          candidate.turnID === turnID &&
          candidate.ownerToken === ownerToken &&
          candidate.epoch === writer.epoch
          ? candidate
          : null;
      });
      if (retained) {
        if (!context.runtime.startPersisted || !context.fenceSource)
          throw new CommandError("unavailable", "Retained Source preparation is not configured");
        // Cold Parent restore/authorization needs the same Change/Turn and
        // Source locks. Release the validation transaction before Resume
        // and transport readiness; neither step grants branch writing.
        if (retained.state !== "ready")
          await context.runtime.startPersisted(changeID, retained.userID);
        await context.fenceSource(changeID, writer.epoch, false, {
          mode: "retained-preparation",
          turnID,
          ownerToken,
          attemptID: writer.fenceAttemptID,
        });
      }
    }
    // An old interactive shell can retain child jobs, Docker execs and services.
    // Confirm full compute teardown rather than pretending shell-PID kill fences it.
    const prepare = async (sql: DatabaseTransaction) => {
      const current = await lockChangeWriterIn(sql, changeID);
      if (
        current.state !== "agent-preparing" ||
        current.epoch !== writer.epoch ||
        current.turnID !== turnID
      )
        throw new CommandError("conflict", "Agent writer changed before fencing");
      await context.fenceSource?.(
        changeID,
        current.epoch,
        false,
        ownerToken && !current.fenceRequired
          ? { mode: "initial-bootstrap", sql, turnID, ownerToken }
          : undefined,
      );
      await context.protect(changeID, []);
      if (
        ownerToken &&
        !current.fenceRequired &&
        !(await turns.validateExecutionIn(sql, turnID, ownerToken))
      )
        throw new CommandError("conflict", "Build authority changed during Source preparation");
    };
    if (ownerToken && !writer.fenceRequired) {
      // Take the operation lock before Turn/Change validation, then share
      // its SQL with Source. A nested Change lock would deadlock startup.
      if (!(await turns.validateExecution(turnID, ownerToken, prepare))) return false;
    } else await database.client.begin(prepare);
    if (
      writer.fenceRequired &&
      !(await awaitRuntimeStopped(context.runtime, context.stopDeadlineMs, writer.fenceAttemptID, {
        turnID,
        epoch: writer.epoch,
      }))
    )
      return false;
    await database.client.begin(async (sql) => {
      const current = await lockChangeWriterIn(sql, changeID);
      if (
        current.state !== "agent-preparing" ||
        current.epoch !== writer.epoch ||
        current.turnID !== turnID ||
        !current.available
      )
        throw new CommandError("conflict", "Agent writing authority changed during preparation");
      if (
        ownerToken &&
        !writer.fenceRequired &&
        !(await turns.validateExecutionIn(sql, turnID, ownerToken))
      )
        throw new CommandError("conflict", "Build authority changed before writer grant");
      await context.protect(changeID, [context.agentUsername]);
      await drizzleTransaction(sql)
        .update(changeWriter)
        .set({
          state: "agent",
          fenceRequired: false,
          updatedAt: query`now()`,
        })
        .where(eq(changeWriter.changeId, changeID));
    });
    return true;
  });
}

export async function confirmAgentSource(
  context: WriterContext,
  turns: AgentTurnStore,
  changeID: string,
  turnID: string,
  ownerToken: string,
  attemptID: string,
  sessionID: string,
) {
  const fenceSource = context.fenceSource;
  if (!fenceSource)
    throw new CommandError("unavailable", "Source role confirmation is not configured");
  const confirmed = await turns.validateExecution(turnID, ownerToken, async (sql) => {
    const writer = await lockChangeWriterIn(sql, changeID);
    if (!writer.available || writer.state !== "agent" || writer.turnID !== turnID)
      throw new CommandError(
        "conflict",
        "Agent writing authority changed before Source confirmation",
      );
    await fenceSource(changeID, writer.epoch, false, {
      mode: "dispatch",
      sql,
      turnID,
      ownerToken,
      attemptID,
      sessionID,
    });
    // The real RPC can outlast the lease. Its read-only role change grants
    // no prompt authority; reject expiry before reporting confirmation.
    if (!(await turns.validateExecutionIn(sql, turnID, ownerToken)))
      throw new CommandError("conflict", "Build authority changed during Source confirmation");
  });
  if (!confirmed)
    throw new CommandError("conflict", "Build authority changed before Source confirmation");
}
