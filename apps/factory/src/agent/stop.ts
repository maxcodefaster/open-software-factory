import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  changeAgentSession,
  changeAgentTurnIntent,
  change as changeTable,
  runtimeAttempt,
} from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";
import { type RuntimeHub } from "../runtime/transport-api";
import type { RuntimeAttemptView } from "../runtime/types";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import {
  cancelQueuedOpenCodeInput,
  confirmEmptyOpenCodeSession,
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  interruptOpenCodeSession,
} from "./opencode-adapter";
import { createStopTransport } from "./stop-transport";

type Database = ReturnType<typeof createDatabase>;
type StopTarget = { stopID: string | null; turnID: string | null };
type StopOrigin = "user" | "authority-loss";
// Caller attribution is available only while its exact publication is in flight.
// A process restart loses this context; recovery must then remain neutral.
const publishingOrigins = new Map<string, { changeID: string; origin: StopOrigin }>();
export type PendingWriterHandoff = { turnID: string; epoch: string };
export type RetainedStopTarget = {
  changeID: string;
  stopID: string;
  attemptID: string;
  sessionID: string;
  promptID: string;
  mode: "interrupt" | "observe";
};

// A review has its own deterministic native Session. Until native confirmation
// is durable, Factory cannot submit its input. A captured stopped Turn fences
// late confirmation and forwarding. Retained implementation history is not
// confirmation of this different Session, nor proof that compute is stopped.
// Keep this proof pure so controlled maintenance can use the same transaction.
export async function confirmUndispatchedReviewStopsIn(
  sql: DatabaseTransaction,
  target?: { changeID: string; stopID: string },
) {
  const db = drizzleTransaction(sql);
  const candidates = await db
    .select({
      changeID: changeAgentSession.changeId,
      stopID: query<string>`${changeAgentSession.stopId}`,
      workspaceID: query<string>`${runtimeAttempt.workspaceId}`,
    })
    .from(changeAgentSession)
    .innerJoin(
      changeTable,
      and(
        eq(changeTable.id, changeAgentSession.changeId),
        eq(changeTable.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
      ),
    )
    .innerJoin(
      runtimeAttempt,
      and(
        eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId),
        isNotNull(runtimeAttempt.workspaceId),
      ),
    )
    .innerJoin(agentTurn, eq(agentTurn.id, changeAgentSession.stopTurnId))
    .where(
      and(
        eq(changeAgentSession.state, "stopped"),
        eq(changeAgentSession.stopPending, true),
        isNotNull(changeAgentSession.stopId),
        isNull(changeAgentSession.nativeSessionConfirmedAt),
        eq(agentTurn.state, "stopped"),
        query`${agentTurn.input}->>'kind'='change-review'`,
        target ? eq(changeTable.id, target.changeID) : undefined,
        target ? eq(changeAgentSession.stopId, target.stopID) : undefined,
      ),
    )
    .orderBy(asc(runtimeAttempt.workspaceId), asc(changeAgentSession.changeId));
  let count = 0;
  for (const candidate of candidates) {
    // Native metadata-worker admission uses this same Workspace lock. Never
    // wait on it while holding maintenance's admission fence, or use the
    // pre-lock snapshot to decide whether an outstanding worker exists.
    const [lock] = await sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${`runtime:${candidate.workspaceID}`})) AS acquired`;
    if (!lock?.acquired) continue;
    const confirmed = await sql<{ changeID: string }[]>`
    UPDATE factory.change_agent_session session SET stop_pending=false,
      stop_dispatched=false,last_error=NULL,updated_at=now()
    FROM factory.change change, factory.runtime_attempt attempt,
      factory.agent_turn turn, factory.change_agent_turn_intent intent,
      factory.candidate_review review
    WHERE session.change_id=change.id AND change.runtime_attempt_id=attempt.id
      AND attempt.id=session.runtime_attempt_id AND attempt.change_id=change.id
      AND attempt.project_id=change.project_id
      AND change.id=${candidate.changeID} AND session.stop_id=${candidate.stopID}
      AND attempt.workspace_id=${candidate.workspaceID}
      AND session.state='stopped' AND session.stop_pending AND NOT session.stop_dispatched
      AND session.stop_id IS NOT NULL AND session.active_turn_id=session.stop_turn_id
      AND session.native_session_confirmed_at IS NULL
      AND session.implementation_session_confirmed_at IS NOT NULL
      AND session.implementation_session_id IS NOT NULL
      AND session.implementation_session_id<>session.opencode_session_id
      AND turn.id=session.stop_turn_id AND turn.change_id=change.id AND turn.state='stopped'
      AND turn.project_id=change.project_id AND turn.ticket_id=change.ticket_id
      AND turn.input->>'kind'='change-review'
      AND intent.turn_id=turn.id AND intent.change_id=change.id AND intent.bootstrap
      AND intent.runtime_attempt_id=attempt.id AND intent.session_id=session.opencode_session_id
      AND review.id=turn.command_id AND review.turn_id=turn.id AND review.change_id=change.id
      AND review.state='pending' AND turn.input->>'reviewId'=review.id::text
      AND turn.authority->'review'->>'reviewId'=review.id::text
      AND session.opencode_session_id='ses_factory_review_'||replace(review.id::text,'-','')
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn other WHERE other.change_id=change.id
        AND other.id<>turn.id AND other.state IN ('pending','dispatching','running','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM factory.substrate_input_stop worker
        WHERE worker.runtime_attempt_id=attempt.id AND worker.completed_at IS NULL)
    RETURNING session.change_id AS "changeID"`;
    count += confirmed.length;
  }
  return count;
}

// Read-only cleanup authority for the original Attempt, not permission to stop
// or dispatch the newly commissioned writer's unassigned input.
export async function requirePendingWriterHandoffIn(
  sql: Database["client"] | DatabaseTransaction,
  attemptID: string,
  handoff: PendingWriterHandoff,
): Promise<void> {
  const [pending] = await sql`
    SELECT attempt.id FROM factory.runtime_attempt attempt
    JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      AND workspace.project_id=attempt.project_id AND workspace.change_id=attempt.change_id
      AND workspace.kind='ticket'
    JOIN factory.change change ON change.id=attempt.change_id AND change.runtime_attempt_id=attempt.id
      AND change.project_id=attempt.project_id
    JOIN factory.ticket ticket ON ticket.id=change.ticket_id AND ticket.id=workspace.ticket_id
      AND ticket.project_id=change.project_id
    JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
      AND approval.ticket_id=ticket.id
    JOIN factory.change_writer writer ON writer.change_id=change.id
    JOIN factory.agent_turn turn ON turn.id=writer.turn_id AND turn.change_id=change.id
      AND turn.project_id=change.project_id AND turn.ticket_id=ticket.id
    JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id AND intent.change_id=change.id
    WHERE attempt.id=${attemptID}
      AND change.state IN ('starting','active','failed') AND change.cancel_requested_at IS NULL
      AND ticket.trashed_at IS NULL
      AND writer.state='agent-preparing' AND writer.turn_id=${handoff.turnID}
      AND writer.epoch=${handoff.epoch}::bigint AND writer.fence_required
      AND writer.fence_attempt_id=attempt.id
      AND turn.state='pending' AND turn.owner_token IS NOT NULL
      AND turn.owner_expires_at>clock_timestamp() AND turn.authority->>'mode'='build'
      AND turn.authority->>'requirementRevisionId'=approval.requirement_revision_id::text
      AND approval.requirement_revision_id=(SELECT id FROM factory.requirement_revision
        WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1)
      AND intent.runtime_attempt_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=workspace.id AND newer.generation>attempt.generation)
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn active
        WHERE active.change_id=change.id AND active.id<>turn.id
          AND active.state IN ('pending','dispatching','running','uncertain'))`;
  if (!pending)
    throw new CommandError(
      "conflict",
      "Pending writer handoff no longer owns cleanup of the original Workspace.",
    );
}

// Substrate teardown must not turn a lost/queued OpenCode input into apparent
// cancellation. A fresh bootstrap whose native confirmation was fenced cannot
// have submitted input; every confirmed/reused Session needs actual settlement.
export async function requireStoppedAgentInputsIn(
  sql: Database["client"] | DatabaseTransaction,
  attemptID: string,
  handoff?: PendingWriterHandoff,
) {
  if (handoff) await requirePendingWriterHandoffIn(sql, attemptID, handoff);
  const [unsettled] = await sql`
    SELECT attempt.id FROM factory.runtime_attempt attempt
    WHERE attempt.id=${attemptID} AND attempt.change_id IS NOT NULL AND (
      EXISTS(SELECT 1 FROM factory.agent_turn turn
        WHERE turn.change_id=attempt.change_id AND turn.state IN ('pending','dispatching','running','uncertain')
          AND turn.id IS DISTINCT FROM ${handoff?.turnID ?? null}::uuid)
      OR EXISTS(SELECT 1 FROM factory.change_agent_session session
        LEFT JOIN factory.change_agent_turn_intent intent ON intent.turn_id=session.stop_turn_id
        LEFT JOIN factory.agent_turn stopped ON stopped.id=session.stop_turn_id
        WHERE session.change_id=attempt.change_id AND session.runtime_attempt_id=attempt.id
          AND NOT COALESCE((
            (session.state IN ('committed','stopped') AND NOT session.stop_pending)
            OR (session.state='stopped' AND session.stop_pending
              AND session.native_session_confirmed_at IS NULL
              AND session.implementation_session_confirmed_at IS NULL
              AND intent.bootstrap AND intent.runtime_attempt_id=attempt.id
              AND intent.session_id=session.opencode_session_id AND stopped.state IN ('stopped','failed','completed'))
          ),false))
    )`;
  if (unsettled)
    throw new CommandError(
      "conflict",
      "Confirm the current Coding input and queued work before stopping compute. The original Actor and Source were retained.",
    );
}

export function createChangeAgentStop(
  database: Database,
  hub: RuntimeHub,
  settleRetained?: (target: RetainedStopTarget) => Promise<boolean>,
  observeRuntime?: (attemptID: string) => Promise<RuntimeAttemptView | null>,
) {
  const usage = createRecordedOpenCodeUsage(database);
  async function settleTarget(
    changeID: string,
    target: StopTarget,
    origin?: StopOrigin,
    sql: Database["client"] | DatabaseTransaction = database.client,
  ) {
    if (!target.turnID) return;
    const summary =
      origin === "user"
        ? "Stopped by the user"
        : origin === "authority-loss"
          ? "Stopped because execution authority could not be renewed"
          : "Execution stopped";
    // Never hold Change while waiting on Turn: execution locks Turn first.
    // A delayed caller can affect only the Turn captured when its Stop began.
    await drizzleTransaction(sql)
      .update(agentTurn)
      .set({
        state: "stopped",
        ownerToken: null,
        ownerExpiresAt: null,
        outcomeSummary: summary,
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(agentTurn.id, target.turnID),
          eq(agentTurn.changeId, changeID),
          inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
        ),
      );
  }

  return {
    async persist(changeID: string, handoff?: PendingWriterHandoff, origin: StopOrigin = "user") {
      const stopID = crypto.randomUUID();
      publishingOrigins.set(stopID, { changeID, origin });
      try {
        // Admission locks Change/Ticket before reading the barrier. Publish it
        // without waiting for any Turn lock: execution locks Turn before Change.
        const target = await database.client.begin(async (sql) => {
          const db = drizzleTransaction(sql);
          const [change] = await sql<{ attemptID: string | null }[]>`
          SELECT change.runtime_attempt_id AS "attemptID" FROM factory.change change
          JOIN factory.ticket ticket ON ticket.id = change.ticket_id
          WHERE change.id = ${changeID} FOR UPDATE OF change, ticket`;
          if (handoff) {
            if (!change?.attemptID)
              throw new CommandError(
                "conflict",
                "Pending writer handoff no longer owns cleanup of the original Workspace.",
              );
            await requirePendingWriterHandoffIn(sql, change.attemptID, handoff);
          }
          // A pending admission may not yet have prepared the Session. With no
          // active turn, retain this exact Session's last assigned input: a failed
          // outcome does not prove that its native Inbox entry was removed.
          const turns = await db
            .select({
              id: agentTurn.id,
              unbound: query<boolean>`${agentTurn.state}='pending' AND ${exists(
                db
                  .select({ turnId: changeAgentTurnIntent.turnId })
                  .from(changeAgentTurnIntent)
                  .where(
                    and(
                      eq(changeAgentTurnIntent.turnId, agentTurn.id),
                      eq(changeAgentTurnIntent.changeId, agentTurn.changeId),
                      isNull(changeAgentTurnIntent.runtimeAttemptId),
                    ),
                  ),
              )}`,
            })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, changeID),
                inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
                query`${agentTurn.id} IS DISTINCT FROM ${handoff?.turnID ?? null}::uuid`,
              ),
            )
            .orderBy(desc(agentTurn.createdAt))
            .limit(1);
          const pending = turns[0];
          if (!handoff && pending?.unbound) {
            const other = alias(agentTurn, "other");
            const [settled] = await db
              .select({ changeId: changeAgentSession.changeId })
              .from(changeAgentSession)
              .where(
                and(
                  eq(changeAgentSession.changeId, changeID),
                  eq(changeAgentSession.state, "stopped"),
                  eq(changeAgentSession.stopPending, false),
                  query`${changeAgentSession.activeTurnId} IS DISTINCT FROM ${pending.id}::uuid`,
                  notExists(
                    db
                      .select({ id: other.id })
                      .from(other)
                      .where(
                        and(
                          eq(other.changeId, changeAgentSession.changeId),
                          ne(other.id, pending.id),
                          inArray(other.state, ["pending", "dispatching", "running", "uncertain"]),
                        ),
                      ),
                  ),
                ),
              );
            if (settled) {
              // Never wait on Turn while holding Change. If execute already
              // owns it, publish the normal Stop barrier below. Otherwise this
              // lock makes cancellation atomic with runtime binding/dispatch.
              const [unbound] = await sql`SELECT turn.id FROM factory.agent_turn turn
                WHERE turn.id=${pending.id} AND turn.change_id=${changeID} AND turn.state='pending'
                  AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
                    WHERE intent.turn_id=turn.id AND intent.change_id=turn.change_id
                      AND intent.runtime_attempt_id IS NULL)
                FOR UPDATE OF turn SKIP LOCKED`;
              if (unbound) {
                // Binding can commit after the locking statement took its
                // snapshot without updating Turn itself. Recheck both records
                // in a fresh statement, now that the Turn lock excludes it.
                const [cancellable] = await db
                  .select({ changeId: changeAgentSession.changeId })
                  .from(changeAgentSession)
                  .innerJoin(
                    changeAgentTurnIntent,
                    and(
                      eq(changeAgentTurnIntent.turnId, pending.id),
                      eq(changeAgentTurnIntent.changeId, changeAgentSession.changeId),
                    ),
                  )
                  .innerJoin(
                    agentTurn,
                    and(
                      eq(agentTurn.id, changeAgentTurnIntent.turnId),
                      eq(agentTurn.state, "pending"),
                    ),
                  )
                  .where(
                    and(
                      eq(changeAgentSession.changeId, changeID),
                      eq(changeAgentSession.state, "stopped"),
                      eq(changeAgentSession.stopPending, false),
                      isNull(changeAgentTurnIntent.runtimeAttemptId),
                      query`${changeAgentSession.activeTurnId} IS DISTINCT FROM ${agentTurn.id}`,
                      notExists(
                        db
                          .select({ id: other.id })
                          .from(other)
                          .where(
                            and(
                              eq(other.changeId, changeAgentSession.changeId),
                              ne(other.id, agentTurn.id),
                              inArray(other.state, [
                                "pending",
                                "dispatching",
                                "running",
                                "uncertain",
                              ]),
                            ),
                          ),
                      ),
                    ),
                  );
                if (cancellable) {
                  await settleTarget(changeID, { stopID: null, turnID: pending.id }, origin, sql);
                  // There is no new native input. Preserve the previous
                  // Session's confirmed Stop instead of inventing a target.
                  return { stopID: null, turnID: pending.id, pendingTurnID: null };
                }
              }
            }
          }
          const rows = await db
            .update(changeAgentSession)
            .set({
              state: "stopped",
              stopId: query`CASE WHEN ${changeAgentSession.stopPending} THEN ${changeAgentSession.stopId} ELSE ${stopID}::uuid END`,
              stopTurnId: query`CASE WHEN ${changeAgentSession.stopPending} THEN ${changeAgentSession.stopTurnId} ELSE COALESCE(
            ${turns[0]?.id ?? null}::uuid,
            ${db
              .select({ turnId: changeAgentTurnIntent.turnId })
              .from(changeAgentTurnIntent)
              .where(
                and(
                  eq(changeAgentTurnIntent.turnId, changeAgentSession.activeTurnId),
                  eq(changeAgentTurnIntent.changeId, changeAgentSession.changeId),
                  eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
                  or(
                    isNull(changeAgentTurnIntent.runtimeAttemptId),
                    eq(changeAgentTurnIntent.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
                  ),
                ),
              )}
          ) END`,
              stopPending: true,
              activeInboxId: null,
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(changeAgentSession.changeId, changeID),
                or(
                  eq(changeAgentSession.stopPending, true),
                  ne(changeAgentSession.state, "stopped"),
                  query`${turns[0]?.id ?? null}::uuid IS NOT NULL`,
                ),
              ),
            )
            .returning({
              stopID: changeAgentSession.stopId,
              turnID: changeAgentSession.stopTurnId,
            });
          return {
            ...(rows[0] ?? { stopID: null, turnID: turns[0]?.id ?? null }),
            pendingTurnID: handoff ? null : (turns[0]?.id ?? null),
          };
        });
        const caller = target.stopID ? publishingOrigins.get(target.stopID) : { changeID, origin };
        await settleTarget(
          changeID,
          target,
          caller?.changeID === changeID ? caller.origin : undefined,
        );
        // A writer handoff may already be settling its old Session. An explicit
        // Stop must also cancel the captured new admission, without replacing
        // that original native-input Stop identity.
        if (target.pendingTurnID && target.pendingTurnID !== target.turnID)
          await settleTarget(changeID, { stopID: null, turnID: target.pendingTurnID }, origin);
      } finally {
        publishingOrigins.delete(stopID);
      }
    },

    async recordUnconfirmed(
      changeID: string,
      target: { stopID: string; attemptID: string; sessionID: string | null },
    ) {
      // One compact recovery outcome after the observer's finite budget, not
      // persistent polling history. A late observer cannot overwrite a new Stop.
      const current = alias(changeAgentSession, "current");
      await database.db
        .update(changeAgentSession)
        .set({
          lastError: query`'Stop remains unconfirmed. The last confirmation check ended without confirmation. ' || CASE
          WHEN ${changeTable.runtimeAttemptId} IS DISTINCT FROM ${changeAgentSession.runtimeAttemptId}
            OR (${changeAgentTurnIntent.runtimeAttemptId} IS NOT NULL AND ${changeAgentTurnIntent.runtimeAttemptId} <> ${changeAgentSession.runtimeAttemptId})
            THEN 'The stopped input belongs to a different Workspace generation; its outcome still needs confirmation.'
          WHEN ${runtimeAttempt.state} = 'stopped' AND ${changeAgentTurnIntent.runtimeAttemptId} IS NOT NULL
            THEN 'Stopped compute cannot prove that assigned input was canceled. Restarting alone does not confirm Stop.'
          WHEN ${runtimeAttempt.state} = 'paused' AND ${changeAgentTurnIntent.runtimeAttemptId} IS NOT NULL
            THEN 'Paused compute retains assigned input. A durable Source checkpoint does not confirm its cancellation.'
          WHEN ${changeAgentSession.opencodeSessionId} IS NULL
            THEN 'The OpenCode Session is not yet identifiable; its create outcome still needs confirmation.'
          WHEN ${runtimeAttempt.state} <> 'ready' OR NOT ${hub.connected(target.attemptID)}
            THEN 'Live Workspace status is unavailable; execution and queued input still need confirmation.'
          WHEN NOT ${changeAgentSession.stopDispatched}
            THEN 'Interruption has not been dispatched. A read-only check will not send it.'
          ELSE 'Ordered history has not proved that execution and queued input are settled.'
        END`,
          updatedAt: query`now()`,
        })
        .from(changeTable)
        .innerJoin(current, eq(current.changeId, changeTable.id))
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, current.runtimeAttemptId))
        .leftJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, current.stopTurnId))
        .where(
          and(
            eq(changeAgentSession.changeId, changeID),
            eq(current.changeId, changeAgentSession.changeId),
            eq(changeTable.id, changeAgentSession.changeId),
            eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId),
            eq(changeAgentSession.state, "stopped"),
            eq(changeAgentSession.stopPending, true),
            eq(changeAgentSession.stopId, target.stopID),
            eq(changeAgentSession.runtimeAttemptId, target.attemptID),
            query`${changeAgentSession.opencodeSessionId} IS NOT DISTINCT FROM ${target.sessionID}`,
          ),
        );
    },

    async confirm(
      changeID: string,
      expectedStopID?: string,
      mode: RetainedStopTarget["mode"] = "interrupt",
    ) {
      const rows = await database.db
        .select({
          attemptID: changeAgentSession.runtimeAttemptId,
          sessionID: changeAgentSession.opencodeSessionId,
          runtimeState: runtimeAttempt.state,
          dispatched: changeAgentSession.stopDispatched,
          stopID: changeAgentSession.stopId,
          turnID: changeAgentSession.stopTurnId,
          promptID: changeAgentTurnIntent.promptId,
          intentAttemptID: changeAgentTurnIntent.runtimeAttemptId,
          currentAttemptID: changeTable.runtimeAttemptId,
          bootstrap: changeAgentTurnIntent.bootstrap,
          intendedSessionID: changeAgentTurnIntent.sessionId,
          sessionConfirmed: query<boolean>`${changeAgentSession.nativeSessionConfirmedAt} IS NOT NULL`,
          implementationConfirmed: query<boolean>`${changeAgentSession.implementationSessionConfirmedAt} IS NOT NULL`,
          turnState: agentTurn.state,
        })
        .from(changeAgentSession)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
        .innerJoin(changeTable, eq(changeTable.id, changeAgentSession.changeId))
        .leftJoin(
          changeAgentTurnIntent,
          eq(changeAgentTurnIntent.turnId, changeAgentSession.stopTurnId),
        )
        .leftJoin(agentTurn, eq(agentTurn.id, changeAgentSession.stopTurnId))
        .where(
          and(
            eq(changeAgentSession.changeId, changeID),
            eq(changeAgentSession.state, "stopped"),
            eq(changeAgentSession.stopPending, true),
            expectedStopID === undefined
              ? undefined
              : eq(changeAgentSession.stopId, expectedStopID),
          ),
        );
      const current = rows[0];
      if (!current) return true;
      // Recovery fences the captured Turn after a crash between publication
      // and settlement. An in-flight publisher can supply its known origin;
      // recovery without that exact caller context must stay neutral.
      const caller = current.stopID ? publishingOrigins.get(current.stopID) : undefined;
      await settleTarget(
        changeID,
        current,
        caller?.changeID === changeID ? caller.origin : undefined,
      );
      const currentStopID = current.stopID;
      if (
        currentStopID &&
        (await database.client.begin((sql) =>
          confirmUndispatchedReviewStopsIn(sql, { changeID, stopID: currentStopID }),
        ))
      )
        return true;
      if (current.currentAttemptID !== current.attemptID) return false;
      // A fresh Session cannot receive its prompt before native confirmation
      // is durable. Stop fences late confirmation. With exact compute teardown,
      // an unconfirmed bootstrap therefore has no queued input to cancel.
      // Reused or confirmed Sessions still require native history.
      const freshBootstrap =
        current.bootstrap === true &&
        !current.sessionConfirmed &&
        current.sessionID === current.intendedSessionID;
      const paused =
        freshBootstrap && !current.implementationConfirmed && current.runtimeState === "paused"
          ? await observeRuntime?.(current.attemptID)
          : null;
      const pausedBootstrap = Boolean(
        paused?.id === current.attemptID &&
          paused.changeId === changeID &&
          paused.workspaceKind === "ticket" &&
          paused.state === "paused" &&
          paused.native?.engine === "substrate" &&
          Boolean(paused.native.actorUID) &&
          paused.native.state === "ACTOR_STATE_SUSPENDED" &&
          paused.native.sourceHandoff === "confirmed-same-node",
      );
      // Only a never-confirmed fresh bootstrap may use the retained native
      // compute fence. A confirmed/reused Session still needs queued-input
      // settlement; Source durability alone can never supply that result.
      const unsubmittedBootstrap =
        freshBootstrap && (current.runtimeState === "stopped" || pausedBootstrap);
      const retainedSettled =
        !unsubmittedBootstrap &&
        current.stopID &&
        current.sessionID &&
        current.promptID &&
        current.intentAttemptID === current.attemptID &&
        !hub.connected(current.attemptID) &&
        ["failed", "cleanup-failed", "stopped", "paused", "starting", "pausing"].includes(
          current.runtimeState,
        ) &&
        Boolean(
          await settleRetained?.({
            changeID,
            stopID: current.stopID,
            attemptID: current.attemptID,
            sessionID: current.sessionID,
            promptID: current.promptID,
            mode,
          }),
        );
      // OpenCode's queued state survives compute suspension. Destruction of a
      // runtime is not evidence that an assigned input has been removed.
      if (
        current.runtimeState === "stopped" &&
        current.intentAttemptID &&
        !unsubmittedBootstrap &&
        !retainedSettled
      )
        return false;
      if (current.intentAttemptID && current.intentAttemptID !== current.attemptID) return false;
      if (current.runtimeState !== "stopped" && !retainedSettled && !unsubmittedBootstrap) {
        if (mode === "observe" && !current.dispatched) return false;
        if (
          !current.stopID ||
          !current.sessionID ||
          current.runtimeState !== "ready" ||
          !hub.connected(current.attemptID)
        )
          return false;
        const transport = createStopTransport(database, hub, {
          changeID,
          stopID: current.stopID,
          attemptID: current.attemptID,
          sessionID: current.sessionID,
        });
        const client = createOpenCodeClient((request, path) => {
          if (mode === "observe" && !["GET", "HEAD"].includes(request.method))
            throw new Error("Stop confirmation cannot mutate OpenCode");
          return transport(request, path);
        });
        let absent = false;
        if (current.dispatched) {
          const confirmed =
            (await confirmEmptyOpenCodeSession(client, current.sessionID)) ||
            (current.promptID &&
              current.intentAttemptID &&
              (await confirmSettledOpenCodeInput(client, current.sessionID, current.promptID)));
          if (!confirmed) return false;
        } else {
          // Commit the CAS before HTTP. It elects one dispatcher without holding
          // a pool connection. Unknown external outcomes are never replayed.
          const dispatched = await database.db
            .update(changeAgentSession)
            .set({
              stopDispatched: true,
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(changeAgentSession.changeId, changeID),
                eq(changeAgentSession.state, "stopped"),
                eq(changeAgentSession.stopPending, true),
                eq(changeAgentSession.stopDispatched, false),
                eq(changeAgentSession.stopId, current.stopID),
                eq(changeAgentSession.runtimeAttemptId, current.attemptID),
                query`${changeAgentSession.opencodeSessionId} IS NOT DISTINCT FROM ${current.sessionID}`,
              ),
            )
            .returning({ id: changeAgentSession.changeId });
          if (!dispatched[0]) return false;
          const interruption = await interruptOpenCodeSession(client, current.sessionID);
          if (interruption === "unconfirmed") return false;
          absent = interruption === "absent";
          if (interruption !== "absent" && current.promptID && current.intentAttemptID) {
            if (!(await cancelQueuedOpenCodeInput(client, current.sessionID, current.promptID)))
              return false;
          }
          if (
            !absent &&
            !(await confirmSettledOpenCodeInput(client, current.sessionID, current.promptID ?? ""))
          )
            return false;
        }
        if (current.turnID && current.turnState === "stopped") {
          if (!absent) await usage.drain(current.turnID, client, current.sessionID);
          await usage.settle(current.turnID, "interrupted");
        }
      }
      if (retainedSettled && current.turnID && current.turnState === "stopped") {
        // Native work is settled, not its unobserved consumption. Preserve the
        // existing journal and mark any missing usage unknown, never zero.
        await usage.settle(current.turnID, "interrupted");
      }
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        // Serialize proof publication with runtime replacement and admission.
        // No external I/O or Turn lock is held while Change is locked.
        const changes = await sql<Array<{ id: string }>>`SELECT id FROM factory.change
          WHERE id = ${changeID} AND runtime_attempt_id = ${current.attemptID} FOR UPDATE`;
        if (!changes[0]) return false;
        if (pausedBootstrap) {
          const [paused] = await db
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .where(
              and(
                eq(runtimeAttempt.id, current.attemptID),
                eq(runtimeAttempt.changeId, changeID),
                eq(runtimeAttempt.state, "paused"),
              ),
            );
          if (!paused) return false;
        }
        if (retainedSettled) {
          const [stopped] = await db
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .where(
              and(
                eq(runtimeAttempt.id, current.attemptID),
                inArray(runtimeAttempt.state, ["stopped", "paused"]),
              ),
            );
          if (!stopped) return false;
        }
        const confirmed = await db
          .update(changeAgentSession)
          .set({
            stopPending: false,
            stopDispatched: false,
            lastError: null,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(changeAgentSession.changeId, changeID),
              eq(changeAgentSession.state, "stopped"),
              eq(changeAgentSession.stopPending, true),
              query`${changeAgentSession.stopId} IS NOT DISTINCT FROM ${current.stopID}`,
              eq(changeAgentSession.runtimeAttemptId, current.attemptID),
              query`${changeAgentSession.opencodeSessionId} IS NOT DISTINCT FROM ${current.sessionID}`,
              unsubmittedBootstrap
                ? isNull(changeAgentSession.nativeSessionConfirmedAt)
                : undefined,
              pausedBootstrap
                ? isNull(changeAgentSession.implementationSessionConfirmedAt)
                : undefined,
            ),
          )
          .returning({ id: changeAgentSession.changeId });
        return confirmed.length === 1;
      });
    },
  };
}
