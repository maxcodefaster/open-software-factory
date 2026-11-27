import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
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
  confirmNativeSession,
  type Database,
  type MonitorTurn,
  type RenewExecution,
  readAgentRow,
  readCurrentChange,
  recordNativeSkillLoads,
} from "./controller-types";
import {
  createOpenCodeClient,
  isOpenCodeObservationTransportError,
  observeOpenCodeWork,
  readOpenCodeInputMessages,
  readOpenCodeWorkspace,
} from "./opencode-adapter";
import {
  admitOrWakeMissingInput,
  claimTurnForRecovery,
  restoreObservedSession,
  restoreTerminalSession,
  settleUncertainRecovery,
} from "./recovery-external-steps";
import {
  assertOpenCodeSessionMatches,
  canTransitionRecoveryPhase,
  connectTurnBrowserAndSources,
  type RecoveryPhase,
  recordLegacySkillOperationsIn,
  startExecutionRenewal,
  syncOpenCodeTurnGuidance,
  transitionRecoveryPhase,
} from "./turn-lifecycle";
import { classifyAgentTurn } from "./turn-outcome";
import type { AgentTurnRecord } from "./turn-record";

export type ExternalTurnRecoveryDeps = {
  database: Database;
  hub: RuntimeHub;
  browser: AgentBrowser | undefined;
  writers: AgentWriters | undefined;
  turns: AgentTurnStore;
  admission: AgentAdmission;
  usageJournal: AgentUsageJournal;
  activity: AgentActivity;
  renewExecution: RenewExecution;
  monitor: MonitorTurn;
  isMonitoring(turnID: string): boolean;
  isStarting(turnID: string): boolean;
};

export function createExternalTurnRecovery(deps: ExternalTurnRecoveryDeps) {
  const {
    database,
    hub,
    browser,
    writers,
    turns,
    admission,
    usageJournal,
    activity,
    renewExecution,
    monitor,
    isMonitoring,
    isStarting,
  } = deps;
  const recovering = new Set<string>();

  return async function recoverExternal(turnID: string) {
    if (activity.isClosed() || recovering.has(turnID) || isMonitoring(turnID) || isStarting(turnID))
      return;
    recovering.add(turnID);
    let phase: RecoveryPhase = "claiming";
    let owned: AgentTurnRecord | null = null;
    let stopRenewal: (() => Promise<void>) | undefined;
    try {
      owned = await claimTurnForRecovery(turns, activity, turnID);
      if (!owned?.ownerToken || owned.authority.mode !== "build" || !("changeId" in owned.command))
        return;
      phase = transitionRecoveryPhase(phase, "observing");
      const ownerToken = owned.ownerToken;
      const changeID = owned.command.changeId;
      const intent = await admission.intent(turnID);
      stopRenewal = startExecutionRenewal(activity, renewExecution, turnID, ownerToken);
      if (!writers)
        throw new CommandError("unavailable", "Change writer enforcement is not configured");
      if (!(await writers.prepareAgent(changeID, turnID)))
        throw new CommandError(
          "conflict",
          "Previous Workspace commands have not stopped during execution recovery",
        );
      const skillRevisionIDs = owned.authority.skillRevisionIds;
      let queueWakeRequested = false;
      let lastObservedAt = performance.now();
      while (!activity.isClosed()) {
        if (!(await turns.renew(turnID, ownerToken)))
          throw new CommandError("conflict", "Build authority changed before external recovery");
        if (!(await turns.validateExecution(turnID, ownerToken)))
          throw new CommandError("conflict", "Build authority changed before external recovery");
        const session = await readAgentRow(database, changeID);
        const current = await readCurrentChange(database, changeID);
        if (
          !session ||
          session.activeTurnID !== turnID ||
          session.state === "stopped" ||
          session.sessionID !== intent.sessionID ||
          !intent.attemptID ||
          session.runtimeAttemptID !== intent.attemptID ||
          current.runtimeAttemptID !== intent.attemptID
        )
          throw new Error(
            "Recorded OpenCode work no longer owns this session and runtime generation",
          );
        if (["failed", "stopped", "cleanup-failed"].includes(current.runtimeState ?? ""))
          throw new Error("Recorded OpenCode runtime is no longer running");
        if (performance.now() - lastObservedAt >= nativeLifecycleWindowMS)
          throw new Error(
            "OpenCode execution could not be observed within the recovery window; its outcome is uncertain",
          );
        if (current.runtimeState !== "ready" || !hub.connected(intent.attemptID)) {
          await Bun.sleep(1_000);
          continue;
        }
        const client = createOpenCodeClient(
          createChangeAgentTransport(database, hub, intent.attemptID, turnID, ownerToken),
        );
        let work: Awaited<ReturnType<typeof observeOpenCodeWork>>;
        let messages: Awaited<ReturnType<typeof readOpenCodeInputMessages>>;
        try {
          const { location } = await readOpenCodeWorkspace(client);
          const retained = await client.session.get(
            { sessionID: intent.sessionID },
            { signal: AbortSignal.any([activity.signal, AbortSignal.timeout(5_000)]) },
          );
          assertOpenCodeSessionMatches(
            retained,
            {
              sessionID: intent.sessionID,
              directory: location.directory,
              modelID: owned.authority.modelId,
            },
            "Recovered OpenCode session does not match its recorded configuration",
          );
          if ((await admission.terminalObservation(intent)).terminal) {
            phase = transitionRecoveryPhase(phase, "restoring");
            const restored = await restoreTerminalSession({
              turns,
              changeID,
              turnID,
              ownerToken,
              attemptID: intent.attemptID,
              intent,
            });
            if (!restored) return;
            phase = transitionRecoveryPhase(phase, "monitoring");
            await monitor(changeID, owned.command.createdBy, turnID, ownerToken);
            return;
          }
          await syncOpenCodeTurnGuidance(client, intent, Boolean(owned.authority.review));
          await usageJournal.drain(turnID, client, intent.sessionID);
          [work, messages] = await Promise.all([
            observeOpenCodeWork(client, intent.sessionID),
            readOpenCodeInputMessages(
              client,
              intent.sessionID,
              intent.promptID,
              AbortSignal.any([activity.signal, AbortSignal.timeout(5_000)]),
            ),
          ]);
        } catch (cause) {
          if (!isOpenCodeObservationTransportError(cause)) throw cause;
          // These reads and exact idempotent guidance bindings may repeat,
          // never inference. Recheck Stop, ownership and runtime next time.
          await Bun.sleep(1_000);
          continue;
        }
        lastObservedAt = performance.now();
        await confirmNativeSession(database, changeID, turnID, intent.attemptID, intent.sessionID);
        await connectTurnBrowserAndSources({
          browser,
          client,
          turnID,
          ownerToken,
          browserTransport: intent.browserTransport,
          isReview: Boolean(owned.authority.review),
        });
        await recordNativeSkillLoads(
          database,
          admission,
          turns,
          turnID,
          ownerToken,
          intent.promptID,
          messages.data,
        );
        const input = messages.data.find(
          (message) => message.type === "user" && message.id === intent.promptID,
        );
        if (!input) {
          phase = transitionRecoveryPhase(phase, "admitting-input");
          const { woke } = await admitOrWakeMissingInput({
            database,
            hub,
            turns,
            usageJournal,
            client,
            changeID,
            turnID,
            ownerToken,
            attemptID: intent.attemptID,
            intent,
            queueWakeRequested,
          });
          phase = transitionRecoveryPhase(phase, "observing");
          if (woke) {
            queueWakeRequested = true;
            continue;
          }
          // Promotion and message observation can race. Never wake a promoted
          // incomplete input; observe its exact history on the next iteration.
          await Bun.sleep(1_000);
          continue;
        }
        if (input.type !== "user" || input.text !== intent.text)
          throw new Error(
            "The recorded OpenCode input is not identifiable in message history; no execution was repeated",
          );
        if (
          !(await turns.validateExecution(turnID, ownerToken, (sql) =>
            recordLegacySkillOperationsIn(sql, turnID, intent, skillRevisionIDs),
          ))
        )
          throw new CommandError(
            "conflict",
            "Build authority changed before recording loaded Skills",
          );
        const outcome = classifyAgentTurn(
          messages.data.map((message) => ({
            id: message.id,
            type: message.type,
            created: message.time.created,
            ...(message.type === "assistant"
              ? {
                  completed: message.time.completed,
                  finish: message.finish,
                  error: message.error,
                }
              : {}),
          })),
          intent.promptID,
          work.running,
        );
        if (outcome.state === "pending" && !work.running)
          throw new Error(
            "Recorded OpenCode input is retained, but no running or completed outcome can be established; no inference was repeated",
          );
        phase = transitionRecoveryPhase(phase, "restoring");
        const restored = await restoreObservedSession({
          database,
          changeID,
          turnID,
          ownerToken,
          attemptID: intent.attemptID,
          intent,
        });
        if (!restored) return;
        phase = transitionRecoveryPhase(phase, "monitoring");
        await monitor(changeID, owned.command.createdBy, turnID, ownerToken);
        return;
      }
    } catch (cause) {
      if (canTransitionRecoveryPhase(phase, "uncertain")) phase = "uncertain";
      await settleUncertainRecovery({ database, turns, activity, turnID, owned, cause });
    } finally {
      await stopRenewal?.();
      await browser?.closeTurn(turnID);
      recovering.delete(turnID);
    }
  };
}
