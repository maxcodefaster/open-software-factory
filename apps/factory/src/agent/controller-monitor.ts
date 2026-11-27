import { and, eq, exists, sql as expression, inArray } from "drizzle-orm";
import { candidateReviewResultInput } from "#conversation-domain/candidate-review";
import { drizzleTransaction } from "#db/client";
import { agentTurn, candidateReview, changeAgentSession, operation } from "#db/schema";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import { codingAllowanceDenial } from "../usage/api";
import { createChangeAgentTransport } from "./change-transport";
import {
  type AgentActivity,
  type AgentAdmission,
  type AgentBrowser,
  type AgentCandidates,
  type AgentRow,
  type AgentSessionArchives,
  type AgentStop,
  type AgentTurnStore,
  type AgentUsageJournal,
  type Database,
  type MonitorTurn,
  type ReconcileStop,
  type RenewExecution,
  readAgentRow,
  recordNativeSkillLoads,
} from "./controller-types";
import { bounded, readableError } from "./native-errors";
import {
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  interruptOpenCodeSession,
  isOpenCodeObservationTransportError,
  observeOpenCodeWork,
  readOpenCodeInputMessages,
} from "./opencode-adapter";
import { createActivityWake } from "./opencode-events";
import { checkTerminalOpenCodeInbox } from "./opencode-terminal";
import { captureTerminalOutcome, validateTerminalMessages } from "./terminal-outcome";
import type { classifyAgentTurn } from "./turn-outcome";

export type AgentMonitorDeps = {
  database: Database;
  hub: RuntimeHub;
  browser: AgentBrowser | undefined;
  turns: AgentTurnStore;
  admission: AgentAdmission;
  usageJournal: AgentUsageJournal;
  archives: AgentSessionArchives;
  candidates: AgentCandidates;
  stop: AgentStop;
  activity: AgentActivity;
  renewExecution: RenewExecution;
  reconcileStop: ReconcileStop;
};

type AgentIntent = Awaited<ReturnType<AgentAdmission["intent"]>>;
type TerminalCheckpoint = NonNullable<
  Awaited<ReturnType<AgentAdmission["terminalObservation"]>>["terminal"]
>;
type ObservedWork = Awaited<ReturnType<typeof observeOpenCodeWork>>;
type OpenCodeClient = ReturnType<typeof createOpenCodeClient>;
type TurnOutcome = ReturnType<typeof classifyAgentTurn>;

export function createAgentMonitor(deps: AgentMonitorDeps): {
  monitor: MonitorTurn;
  isMonitoring(turnID: string): boolean;
} {
  const {
    database,
    hub,
    browser,
    turns,
    admission,
    usageJournal,
    archives,
    candidates,
    stop,
    activity,
    renewExecution,
    reconcileStop,
  } = deps;
  const monitors = new Set<string>();

  async function handleOwnershipRefusal(changeID: string, turnID: string, ownerToken: string) {
    const [current] = await database.client<
      { ownerExpiresAt: string | null; observedAt: string; expired: boolean }[]
    >`WITH observation AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT turn.owner_expires_at::text AS "ownerExpiresAt",
        observation.at::text AS "observedAt",
        COALESCE(turn.owner_expires_at <= observation.at,false) AS expired
      FROM factory.agent_turn turn CROSS JOIN observation
      WHERE turn.id=${turnID} AND turn.change_id=${changeID}
        AND turn.owner_token=${ownerToken} AND turn.state='running'`;
    // A completed Stop or another owner is not a new Stop request. Actual
    // revoked execution is fenced before asking the engine to settle.
    if (current) {
      console.warn("[factory] Coding ownership renewal refused", {
        turnID,
        changeID,
        ownerExpiresAt: current.ownerExpiresAt,
        observedAt: current.observedAt,
        expired: current.expired,
      });
      await stop.persist(changeID, undefined, "authority-loss");
      activity.run(reconcileStop(changeID));
    }
  }

  async function verifyTerminalCheckpoint(params: {
    client: OpenCodeClient;
    intent: AgentIntent;
    checkpoint: TerminalCheckpoint;
    work: ObservedWork;
    messagesData: Awaited<ReturnType<typeof readOpenCodeInputMessages>>["data"];
    sessionID: string;
    turnID: string;
    ownerToken: string;
  }): Promise<
    { status: "continue" } | { status: "return" } | { status: "outcome"; outcome: TurnOutcome }
  > {
    const { client, intent, checkpoint, work, messagesData, sessionID, turnID, ownerToken } =
      params;
    let outcome = validateTerminalMessages(checkpoint, intent, messagesData);
    if (
      work.unknownShell ||
      work.shells.some(
        (shell) =>
          !checkpoint.shells.some(
            (recorded) =>
              recorded.id === shell.id && recorded.sessionID === shell.metadata.sessionID,
          ),
      )
    )
      throw new Error("Terminal cleanup found an unknown or newly created native shell");
    await checkTerminalOpenCodeInbox(client, sessionID, checkpoint.shells);
    if (work.running) {
      // Only the checkpoint phase may interrupt post-terminal native
      // wakeups: its relay fence prevents further provider admission.
      if (!(await renewExecution(turnID, ownerToken))) return { status: "continue" };
      if ((await interruptOpenCodeSession(client, sessionID)) === "unconfirmed")
        throw new Error("OpenCode finished but its background shell cleanup is unconfirmed");
      await checkTerminalOpenCodeInbox(client, sessionID, checkpoint.shells, true);
      // Confirm through fresh execution/history reads on the next loop.
      return { status: "continue" };
    }
    await checkTerminalOpenCodeInbox(client, sessionID, checkpoint.shells, true);
    if (!(await confirmSettledOpenCodeInput(client, sessionID, intent.promptID)))
      throw new Error("OpenCode terminal input and its execution tree are not settled");
    // A new input can have been promoted during cleanup. Quiescence
    // alone does not establish that the exact input still owns history.
    const settledMessages = await readOpenCodeInputMessages(
      client,
      sessionID,
      intent.promptID,
      AbortSignal.any([activity.signal, AbortSignal.timeout(5_000)]),
    );
    outcome = validateTerminalMessages(checkpoint, intent, settledMessages.data);
    if (!(await confirmSettledOpenCodeInput(client, sessionID, intent.promptID)))
      throw new Error("OpenCode work changed during the terminal history confirmation");
    if (activity.isClosed()) return { status: "return" };
    return { status: "outcome", outcome };
  }

  async function settleFailedTurn(
    changeID: string,
    turnID: string,
    ownerToken: string,
    activeInboxID: string | null,
    error: unknown,
  ) {
    const pause = await database.db
      .select({ id: operation.id })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "usage.coding_pause"),
          eq(operation.scopeType, "agent_turn"),
          eq(operation.scopeId, turnID),
          eq(operation.state, "paused"),
          expression`(${operation.payload}->>'resumedByTurnId') IS NULL`,
        ),
      );
    await usageJournal.settle(
      turnID,
      "failed",
      Boolean(pause.length) && readableError(error).includes(codingAllowanceDenial),
    );
    const summary = pause.length
      ? "Coding paused at its allowance. Existing code is retained. Resume explicitly after reset or an allowance increase."
      : bounded(readableError(error), 2_000);
    await turns.settle(turnID, ownerToken, "failed", summary);
    await database.db
      .update(changeAgentSession)
      .set({ state: "failed", lastError: summary, updatedAt: expression`now()` })
      .where(
        and(
          eq(changeAgentSession.changeId, changeID),
          eq(changeAgentSession.state, "working"),
          eq(changeAgentSession.activeTurnId, turnID),
          expression`${changeAgentSession.activeInboxId} = ${activeInboxID}::text`,
          exists(
            database.db
              .select({ id: agentTurn.id })
              .from(agentTurn)
              .where(and(eq(agentTurn.id, turnID), eq(agentTurn.state, "failed"))),
          ),
        ),
      );
  }

  async function settleSucceededTurn(params: {
    changeID: string;
    userID: string;
    turnID: string;
    ownerToken: string;
    session: AgentRow;
    sessionID: string;
    intent: AgentIntent;
    client: OpenCodeClient;
    summaryText: string | undefined;
  }) {
    const {
      changeID,
      userID,
      turnID,
      ownerToken,
      session,
      sessionID,
      intent,
      client,
      summaryText,
    } = params;
    if (!(await confirmSettledOpenCodeInput(client, sessionID, intent.promptID)))
      throw new Error(
        "OpenCode reported a final answer but its execution tree or queued input is not settled",
      );
    // Shutdown can start during the final native settlement reads.
    // Join that observation without publishing its late result.
    if (activity.isClosed()) return;
    await usageJournal.settle(turnID, "completed");
    const reviewTurn = await turns.get(turnID);
    if (reviewTurn?.authority.mode === "build" && reviewTurn.authority.review) {
      await browser?.finishTurnRecording(turnID, ownerToken, activity.signal);
      const reviewID = reviewTurn.authority.review.reviewId;
      const [review] = await database.db
        .select({ result: candidateReview.result })
        .from(candidateReview)
        .where(and(eq(candidateReview.id, reviewID), eq(candidateReview.turnId, turnID)));
      const parsed = candidateReviewResultInput.safeParse(review?.result);
      const result = parsed.success ? parsed.data : null;
      const summary =
        result?.summary ??
        "Independent review ended without an accepted report. This candidate remains unverified.";
      const settled = await turns.settle(
        turnID,
        ownerToken,
        "completed",
        bounded(summary, 2_000),
        async (sql) => {
          const db = drizzleTransaction(sql);
          await db
            .update(candidateReview)
            .set({ state: result?.verdict ?? "incomplete", completedAt: expression`now()` })
            .where(
              and(
                eq(candidateReview.id, reviewID),
                eq(candidateReview.turnId, turnID),
                inArray(candidateReview.state, ["pending", "running"]),
              ),
            );
          await db
            .update(changeAgentSession)
            .set({
              state: "committed",
              activeInboxId: null,
              lastError: null,
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(changeAgentSession.changeId, changeID),
                eq(changeAgentSession.activeTurnId, turnID),
                eq(changeAgentSession.state, "working"),
                expression`${changeAgentSession.activeInboxId} = ${session.activeInboxID}::text`,
              ),
            );
        },
      );
      if (!settled)
        throw new CommandError("conflict", "Review no longer owns this exact candidate");
      activity.notifyActivity(changeID);
      activity.run(archives.savePending());
      return;
    }
    const settled = await turns.settle(
      turnID,
      ownerToken,
      "completed",
      summaryText
        ? bounded(`Agent reports completion: ${summaryText}`, 2_000)
        : "OpenCode ended this Build turn. Source submission and independent Verification are separate steps; Delivery still requires approval.",
      async (sql) => {
        const accepted = await drizzleTransaction(sql)
          .update(changeAgentSession)
          .set({
            state: "waiting",
            activeInboxId: null,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(changeAgentSession.changeId, changeID),
              eq(changeAgentSession.state, "working"),
              eq(changeAgentSession.activeTurnId, turnID),
              expression`${changeAgentSession.activeInboxId} = ${session.activeInboxID}::text`,
            ),
          )
          .returning({ id: changeAgentSession.changeId });
        if (!accepted[0])
          throw new CommandError("conflict", "Build outcome no longer owns this session");
        await candidates.record(sql, session, userID, turnID);
      },
    );
    if (!settled)
      throw new CommandError("conflict", "Build outcome no longer owns its current authority");
    activity.notifyActivity(changeID);
    activity.run(archives.savePending());
    await candidates.reconcile(turnID);
  }

  async function monitor(changeID: string, userID: string, turnID: string, ownerToken: string) {
    if (activity.isClosed() || monitors.has(turnID)) return;
    monitors.add(turnID);
    let inactiveObservations = 0;
    let lastObservedAt = performance.now();
    const wake = createActivityWake(activity.signal);
    let detach: (() => void) | undefined;
    try {
      const intent = await admission.intent(turnID);
      const initial = await readAgentRow(database, changeID);
      if (!initial?.sessionID) return;
      const client = createOpenCodeClient(
        createChangeAgentTransport(database, hub, initial.runtimeAttemptID, turnID, ownerToken),
      );
      detach = activity.subscribeAttemptEvents(initial.runtimeAttemptID, (type) => {
        // Token deltas update the panel, not durable usage/settlement reads.
        if (!type.endsWith(".delta") && type !== "session.tool.progress") wake.notify();
      });
      while (!activity.isClosed()) {
        const revision = wake.revision();
        const session = await readAgentRow(database, changeID);
        if (!session?.sessionID || session.activeTurnID !== turnID) return;
        const sessionID = session.sessionID;
        if (session.state === "stopped") {
          activity.run(reconcileStop(changeID));
          return;
        }
        if (session.state !== "working") return;
        if (!(await renewExecution(turnID, ownerToken))) {
          await handleOwnershipRefusal(changeID, turnID, ownerToken);
          return;
        }
        const latestSession = await readAgentRow(database, changeID);
        if (latestSession?.state !== "working" || latestSession.activeTurnID !== turnID) return;
        if (["failed", "stopped", "cleanup-failed"].includes(session.runtimeState)) {
          throw new Error("The Ticket Workspace stopped during implementation");
        }
        // Ownership renewal is not evidence that the admitted execution is
        // observable. Keep this deadline outside the transport retry catch.
        if (performance.now() - lastObservedAt >= nativeLifecycleWindowMS)
          throw new Error(
            "OpenCode execution could not be observed within the recovery window; its outcome is uncertain",
          );
        if (!hub.connected(session.runtimeAttemptID) || session.runtimeState !== "ready") {
          await Bun.sleep(1_000);
          continue;
        }
        try {
          if (session.runtimeAttemptID !== initial.runtimeAttemptID) return;
          // Sample before native work/history. Relay dispatch advances this
          // epoch under the same Turn lock used to persist the checkpoint.
          const terminalObservation = await admission.terminalObservation(intent);
          const work = await observeOpenCodeWork(client, sessionID);
          const [, messages] = await Promise.all([
            usageJournal.drain(turnID, client, sessionID, work.sessionIDs),
            readOpenCodeInputMessages(
              client,
              sessionID,
              intent.promptID,
              AbortSignal.any([activity.signal, AbortSignal.timeout(5_000)]),
            ),
          ]);
          // Successful long-running inference needs no new tokens or terminal
          // answer: a complete work/history observation renews this window.
          lastObservedAt = performance.now();
          await recordNativeSkillLoads(
            database,
            admission,
            turns,
            turnID,
            ownerToken,
            session.activeInboxID,
            messages.data,
          );
          const checkpoint = terminalObservation.terminal;
          if (!checkpoint) {
            const captured = captureTerminalOutcome(
              intent,
              messages.data,
              work,
              terminalObservation.epoch,
            );
            if (captured) {
              // Persist before any interrupt/removal. A concurrent inference
              // admission makes the observation stale and requires a new read.
              await admission.checkpointTerminal(intent, ownerToken, captured);
              continue;
            }
          }
          let outcome: TurnOutcome = { state: "pending" };
          if (checkpoint) {
            const verified = await verifyTerminalCheckpoint({
              client,
              intent,
              checkpoint,
              work,
              messagesData: messages.data,
              sessionID,
              turnID,
              ownerToken,
            });
            if (verified.status === "continue") continue;
            if (verified.status === "return") return;
            outcome = verified.outcome;
          }
          if (activity.isClosed()) return;
          // History can observe a terminal outcome after the earlier log watermark.
          // Drain again before settlement so the last paid step cannot be missed.
          if (outcome.state === "failed" || outcome.state === "succeeded")
            await usageJournal.drain(turnID, client, sessionID);
          if (outcome.state === "failed") {
            await settleFailedTurn(
              changeID,
              turnID,
              ownerToken,
              session.activeInboxID,
              outcome.error,
            );
            return;
          }
          if (outcome.state === "succeeded") {
            await settleSucceededTurn({
              changeID,
              userID,
              turnID,
              ownerToken,
              session,
              sessionID,
              intent,
              client,
              summaryText: outcome.summary,
            });
            return;
          }
          // A single active/history pair can straddle upstream promotion or
          // completion. A second inactive observation, one interval later,
          // cannot justify renewing a stranded turn indefinitely. Keep the
          // result uncertain and require explicit recovery, never paid replay.
          inactiveObservations = work.running ? 0 : inactiveObservations + 1;
          if (inactiveObservations >= 2)
            throw new Error(
              "OpenCode has no active execution or terminal outcome for the recorded input; recovery requires an explicit decision",
            );
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : "OpenCode status failed";
          // These are read-only observations of the recorded execution. Losing
          // one response is not a lost prompt receipt and must not fence a live
          // turn. Renewal and Stop checks still run before the next observation.
          if (
            hub.connected(session.runtimeAttemptID) &&
            !isOpenCodeObservationTransportError(cause) &&
            !error.includes("timed out")
          )
            throw cause;
        }
        if (inactiveObservations) await Bun.sleep(1_000);
        else await wake.wait(revision, 15_000);
        if (!activity.isClosed()) await Bun.sleep(100);
      }
    } finally {
      detach?.();
      wake.dispose();
      await browser?.closeTurn(turnID);
      monitors.delete(turnID);
      activity.notifyActivity(changeID);
    }
  }

  return {
    monitor,
    isMonitoring: (turnID: string) => monitors.has(turnID),
  };
}
