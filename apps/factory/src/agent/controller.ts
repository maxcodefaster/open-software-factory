import { and, eq, inArray } from "drizzle-orm";
import { factorySigningSecret } from "#auth/signing-secret";
import type { CodingReasoning } from "#conversation-domain/model-settings";
import type { DatabaseTransaction } from "#db/client";
import { agentTurn, change as changeTable } from "#db/schema";
import { CommandError } from "../command-error";
import {
  createModelConnections,
  createModelSettingsController,
  createOpenBaoModelSecrets,
} from "../models/api";
import type { RuntimeHub } from "../runtime/transport-api";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import { createAgentCandidates } from "./candidate-agent";
import { createChangeAdmission } from "./change-admission";
import { createAgentActivity, createExecutionRenewer } from "./controller-activity";
import { createAgentDispatcher } from "./controller-dispatch";
import { createAgentMonitor } from "./controller-monitor";
import { createAgentRecovery, createStopReconciler } from "./controller-recovery";
import {
  type AgentBrowser,
  type AgentWriters,
  type Database,
  opencode,
  type RetainedStopSettler,
  type RuntimeController,
  readAgentRow,
} from "./controller-types";
import { createAgentViews } from "./controller-views";
import { createReviewAdmission } from "./review-admission";
import { createSessionArchives } from "./session-archive-store";
import { createChangeAgentStop, type PendingWriterHandoff } from "./stop";
import { createAgentTurnStore } from "./turn-store";

export function createAgentController(
  database: Database,
  hub: RuntimeHub,
  runtime: RuntimeController,
  browser?: AgentBrowser,
  writers?: AgentWriters,
  settleRetainedStop?: RetainedStopSettler,
) {
  const activity = createAgentActivity(hub, browser);
  const turns = createAgentTurnStore(database);
  const usageJournal = createRecordedOpenCodeUsage(database);
  const archives = createSessionArchives(database, (attemptID) => opencode(hub, attemptID));
  const modelSettings = createModelSettingsController(database);
  const modelConnections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    factorySigningSecret(),
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [],
  );
  const admission = createChangeAdmission(
    database,
    (sql, context) => modelSettings.resolve("build", sql, context),
    (sql) => modelConnections.reference("build", sql),
  );
  const stop = createChangeAgentStop(
    database,
    hub,
    settleRetainedStop ? (target) => settleRetainedStop(target, activity.signal) : undefined,
    runtime.get?.bind(runtime),
  );
  const admitReview = createReviewAdmission(database, async (sql, context) => {
    const modelId = await modelSettings.resolve("build", sql, { ...context, personal: false });
    const modelConnection = await modelConnections.reference("build", sql);
    return { modelId, ...(modelConnection ? { modelConnection } : {}) };
  });
  const candidates = createAgentCandidates(database, hub, activity.isClosed);
  const renewExecution = createExecutionRenewer(turns, activity, browser);
  const reconcileStop = createStopReconciler({ database, stop, activity });
  const monitoring = createAgentMonitor({
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
  });
  const dispatcher = createAgentDispatcher({
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
    monitor: monitoring.monitor,
  });
  const recovery = createAgentRecovery({
    database,
    hub,
    runtime,
    browser,
    writers,
    turns,
    admission,
    usageJournal,
    archives,
    candidates,
    activity,
    renewExecution,
    reconcileStop,
    monitor: monitoring.monitor,
    execute: dispatcher.execute,
    isMonitoring: monitoring.isMonitoring,
    isStarting: dispatcher.isStarting,
    hasRetainedStopSettler: Boolean(settleRetainedStop),
  });
  const views = createAgentViews({ database, hub, archives, activity });

  return {
    shutdown: activity.shutdown,
    subscribeActivity: activity.subscribeActivity,
    runtimeActivityChanged() {
      activity.notifyActivity();
    },
    recover: recovery.recover,
    recoverRuntimeWork: recovery.recoverRuntimeWork,
    dispatchRuntimePending: recovery.dispatchRuntimePending,
    recoverRetainedStops: recovery.recoverRetainedStops,
    dispatchReadyPending: recovery.dispatchReadyPending,

    async start(
      changeID: string,
      userID: string,
      commandId: string,
      codingReasoning?: CodingReasoning,
      contextID?: string,
    ) {
      if (activity.isClosed()) throw new Error("Agent controller is closed");
      const accepted = await admission.admit(changeID, userID, {
        kind: "change-start",
        commandId,
        ...(codingReasoning ? { codingReasoning } : {}),
        ...(contextID ? { contextId: contextID } : {}),
      });
      if (!accepted.replayed) activity.run(dispatcher.execute(accepted.turn.id));
      return views.get(changeID, accepted.turn.id);
    },

    async resume(changeID: string, userID: string, commandID: string, pausedTurnID: string) {
      const turnID = await dispatcher.resume(changeID, userID, commandID, pausedTurnID);
      return views.get(changeID, turnID);
    },

    admitStartIn(
      sql: DatabaseTransaction,
      changeID: string,
      userID: string,
      commandId: string,
      codingReasoning?: CodingReasoning,
    ) {
      return admission.admitIn(sql, changeID, userID, {
        kind: "change-start",
        commandId,
        ...(codingReasoning ? { codingReasoning } : {}),
      });
    },

    async dispatchPending(changeID: string) {
      const pending = await database.db
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .innerJoin(changeTable, eq(changeTable.id, agentTurn.changeId))
        .where(
          and(
            eq(changeTable.id, changeID),
            inArray(changeTable.state, ["starting", "active"]),
            eq(agentTurn.state, "pending"),
          ),
        );
      for (const turn of pending) activity.run(dispatcher.execute(turn.id));
    },

    async prompt(
      changeID: string,
      text: string,
      userID: string,
      commandId: string,
      repair = false,
      contextID?: string,
    ) {
      if (activity.isClosed()) throw new Error("Agent controller is closed");
      const accepted = await admission.admit(changeID, userID, {
        kind: repair ? "change-repair" : "change-prompt",
        commandId,
        text,
        ...(contextID ? { contextId: contextID } : {}),
      });
      if (!accepted.replayed) activity.run(dispatcher.execute(accepted.turn.id));
      return views.get(changeID, accepted.turn.id);
    },

    async admitPromptIn(
      sql: DatabaseTransaction,
      changeID: string,
      userID: string,
      text: string,
      commandId: string,
    ) {
      if (activity.isClosed()) throw new Error("Agent controller is closed");
      const accepted = await admission.admitIn(sql, changeID, userID, {
        kind: "change-prompt",
        commandId,
        text,
      });
      return accepted.turn.id;
    },

    async review(changeID: string, reviewID: string, userID: string) {
      if (activity.isClosed()) throw new Error("Agent controller is closed");
      const accepted = await admitReview(changeID, reviewID, userID);
      if (!accepted.replayed) activity.run(dispatcher.execute(accepted.turn.id));
      return views.get(changeID, accepted.turn.id);
    },

    async stop(changeID: string, handoff?: PendingWriterHandoff) {
      await stop.persist(changeID, handoff);
      activity.notifyActivity(changeID);
      await browser?.closeChange(changeID);
      try {
        if (!(await stop.confirm(changeID))) activity.run(reconcileStop(changeID));
      } catch {
        activity.run(reconcileStop(changeID));
      }
      return views.get(changeID);
    },

    async recheckStop(changeID: string, stopID: string) {
      if (activity.isClosed()) throw new Error("Agent controller is closed");
      const target = await readAgentRow(database, changeID);
      if (!target?.stopPending) return views.get(changeID);
      if (target.stopID !== stopID)
        throw new CommandError(
          "conflict",
          "Stop changed. Refresh its status before checking confirmation.",
        );
      let confirmed = false;
      try {
        confirmed = await stop.confirm(changeID, stopID, "observe");
      } catch {
        // A failed read leaves Stop pending, with no mutation or paid replay.
      }
      if (!confirmed)
        await stop.recordUnconfirmed(changeID, {
          stopID,
          attemptID: target.runtimeAttemptID,
          sessionID: target.sessionID,
        });
      return views.get(changeID);
    },

    retainedMessages: views.retainedMessages,
    newConversation: views.newConversation,
    get: views.get,
  };
}
