import { and, eq } from "drizzle-orm";
import { agentTurn, change as changeTable, operation } from "#db/schema";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import { createChangeAgentTransport } from "./change-transport";
import {
  type AgentActivity,
  type AgentAdmission,
  type AgentBrowser,
  type AgentTurnStore,
  type AgentUsageJournal,
  type AgentWriters,
  awaitConfiguredModel,
  awaitReadyChange,
  confirmNativeSession,
  type Database,
  type ExecuteTurn,
  type MonitorTurn,
  type RenewExecution,
  type RuntimeController,
  readCurrentChange,
} from "./controller-types";
import { installNativeSkills, prepareReviewApps } from "./dispatch-preparation";
import { resumePausedTurn } from "./dispatch-resume";
import {
  markTurnSessionRunning,
  openOrCreateTurnSession,
  prepareTurnSession,
  settleDispatchFailure,
} from "./dispatch-session";
import {
  createOpenCodeClient,
  ensureOpenCodeMessageBoundary,
  promptRecordedOpenCodeInput,
  readOpenCodeWorkspace,
} from "./opencode-adapter";
import {
  activeCodingPausePredicate,
  connectTurnBrowserAndSources,
  type DispatchPhase,
  startExecutionRenewal,
  syncOpenCodeTurnGuidance,
  transitionDispatchPhase,
} from "./turn-lifecycle";
import type { AgentTurnRecord } from "./turn-record";

export type AgentDispatchDeps = {
  database: Database;
  hub: RuntimeHub;
  runtime: RuntimeController;
  browser: AgentBrowser | undefined;
  writers: AgentWriters | undefined;
  turns: AgentTurnStore;
  admission: AgentAdmission;
  usageJournal: AgentUsageJournal;
  activity: AgentActivity;
  renewExecution: RenewExecution;
  monitor: MonitorTurn;
};

export function createAgentDispatcher(deps: AgentDispatchDeps): {
  execute: ExecuteTurn;
  resume(
    changeID: string,
    userID: string,
    commandID: string,
    pausedTurnID: string,
  ): Promise<string>;
  isStarting(turnID: string): boolean;
} {
  const {
    database,
    hub,
    runtime,
    browser,
    writers,
    turns,
    admission,
    usageJournal,
    activity,
    renewExecution,
    monitor,
  } = deps;
  const starters = new Set<string>();

  async function execute(turnID: string) {
    if (activity.isClosed() || starters.has(turnID)) return;
    starters.add(turnID);
    let phase: DispatchPhase = "pending";
    let owned: AgentTurnRecord | null = null;
    let stopRenewal: (() => Promise<void>) | undefined;
    let startupRejected = false;
    try {
      // Branch creation is independently recovered. A recorded bootstrap waits
      // for that outcome without claiming a lease or dispatching any inference.
      const [branch] = await database.db
        .select({ state: changeTable.state })
        .from(agentTurn)
        .innerJoin(changeTable, eq(changeTable.id, agentTurn.changeId))
        .where(eq(agentTurn.id, turnID));
      if (branch?.state === "branch-pending") return;
      owned = await turns.claimPending(turnID);
      if (!owned?.ownerToken || owned.authority.mode !== "build" || !("changeId" in owned.command))
        return;
      phase = transitionDispatchPhase(phase, "claimed");
      const ownerToken = owned.ownerToken;
      const userID = owned.command.createdBy;
      const skillRevisionIDs = owned.authority.skillRevisionIds;
      const changeID = owned.command.changeId;
      const reviewAuthority = owned.authority.review;
      const intent = await admission.intent(turnID);
      stopRenewal = startExecutionRenewal(activity, renewExecution, turnID, ownerToken);
      if (!writers)
        throw new CommandError("unavailable", "Change writer enforcement is not configured");
      if (!(await writers.prepareAgent(changeID, turnID, ownerToken))) {
        await turns.failRevokedPendingPreparation(
          turnID,
          ownerToken,
          "Build authority changed before Source preparation",
        );
        await turns.releasePending(turnID, ownerToken);
        return;
      }
      if (!(await turns.validateExecution(turnID, ownerToken)))
        throw new CommandError("conflict", "Build authority changed before runtime startup");
      let current = await readCurrentChange(database, changeID);
      if (intent.attemptID && intent.attemptID !== current.runtimeAttemptID) {
        throw new Error("The recorded runtime generation changed before Build dispatch");
      }
      if (!current.runtimeAttemptID || current.runtimeState !== "ready") {
        try {
          await runtime.startPersisted(changeID, userID);
        } catch (cause) {
          startupRejected = true;
          throw cause;
        }
        current = await readCurrentChange(database, changeID);
      }
      if (!current.runtimeAttemptID) throw new Error("Ticket Sandbox was not created");
      const attemptID = current.runtimeAttemptID;
      const prepared = await prepareTurnSession(database, {
        turnID,
        ownerToken,
        changeID,
        attemptID,
        userID,
        intent,
        isReview: Boolean(reviewAuthority),
      });
      if (!prepared) return;
      phase = transitionDispatchPhase(phase, "prepared");
      if (
        (
          await database.db
            .select({ id: operation.id })
            .from(operation)
            .where(
              and(
                eq(operation.kind, "runtime.compute_wait"),
                eq(operation.scopeType, "runtime_attempt"),
                eq(operation.scopeId, attemptID),
                eq(operation.idempotencyKey, `runtime.compute_wait:${attemptID}`),
              ),
            )
        ).length
      ) {
        await turns.releasePending(turnID, ownerToken);
        return;
      }
      const change = await awaitReadyChange(
        database,
        changeID,
        turnID,
        attemptID,
        activity.isClosed,
      );
      const client = createOpenCodeClient(
        createChangeAgentTransport(database, hub, change.runtimeAttemptID, turnID, ownerToken),
      );
      await awaitConfiguredModel(client, owned.authority.modelId, () =>
        activity.isClosed() ? Promise.resolve(false) : turns.validateExecution(turnID, ownerToken),
      );
      const { location } = await readOpenCodeWorkspace(client);
      if (intent.skillManifest !== null) {
        await installNativeSkills(hub, turns, {
          attemptID,
          turnID,
          ownerToken,
          client,
          location,
          intent,
          skillRevisionIDs,
        });
      }
      // Initial role initialization may have preceded the first Source Parent.
      // A real current-epoch read-only fence is mandatory here, including when
      // the runtime was already ready or a previous restore used an old epoch.
      await writers.confirmSource(changeID, turnID, ownerToken, attemptID, intent.sessionID);
      if (!(await turns.beginDispatch(turnID, ownerToken))) {
        if (
          (
            await database.db
              .select({ id: operation.id })
              .from(operation)
              .where(activeCodingPausePredicate(turnID))
          ).length
        )
          return;
        throw new CommandError("conflict", "Build authority changed before dispatch");
      }
      phase = transitionDispatchPhase(phase, "dispatched");
      if (reviewAuthority) {
        await prepareReviewApps(hub, runtime, turns, activity, {
          attemptID,
          turnID,
          ownerToken,
          intent,
          current,
          candidate: reviewAuthority.commitSha,
        });
      }
      await openOrCreateTurnSession({
        client,
        intent,
        location,
        modelID: owned.authority.modelId,
        isReview: Boolean(reviewAuthority),
        skillRevisionIDs,
      });
      await confirmNativeSession(database, changeID, turnID, attemptID, intent.sessionID);
      if (!(await turns.validateExecution(turnID, ownerToken)))
        throw new CommandError("conflict", "Build authority changed before prompt submission");
      await ensureOpenCodeMessageBoundary(client, intent.sessionID);
      await usageJournal.prepare(turnID, client, intent.sessionID);
      await syncOpenCodeTurnGuidance(client, intent, Boolean(reviewAuthority));
      await connectTurnBrowserAndSources({
        browser,
        client,
        turnID,
        ownerToken,
        browserTransport: intent.browserTransport,
        isReview: Boolean(reviewAuthority),
      });
      const inbox = await promptRecordedOpenCodeInput(client, intent, true);
      if (inbox.id !== intent.promptID)
        throw new Error("OpenCode returned another prompt identity");
      const running = await markTurnSessionRunning(turns, {
        turnID,
        ownerToken,
        changeID,
        intent,
        skillRevisionIDs,
        reviewID: reviewAuthority?.reviewId,
      });
      if (!running) {
        // The accepted prompt may still be running, or Stop may already have
        // released this Session to another turn. Only settle our owned record;
        // a late response must never interrupt the Session's newer work.
        throw new CommandError("conflict", "Build authority changed after prompt acceptance");
      }
      phase = transitionDispatchPhase(phase, "running");
      // Keep the independent renewal timer alive while monitoring this exact turn.
      await monitor(changeID, userID, owned.id, ownerToken);
      phase = transitionDispatchPhase(phase, "settled");
    } catch (cause) {
      await settleDispatchFailure(database, turns, activity, {
        turnID,
        owned,
        dispatched: phase === "dispatched" || phase === "running",
        startupRejected,
        cause,
      });
    } finally {
      await stopRenewal?.();
      await browser?.closeTurn(turnID);
      starters.delete(turnID);
    }
  }

  return {
    execute,
    resume: (changeID, userID, commandID, pausedTurnID) =>
      resumePausedTurn(
        { database, hub, turns, admission, activity, execute },
        changeID,
        userID,
        commandID,
        pausedTurnID,
      ),
    isStarting: (turnID: string) => starters.has(turnID),
  };
}
