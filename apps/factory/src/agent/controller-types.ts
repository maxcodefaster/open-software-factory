import { and, eq, sql as expression, ne, not } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentSession,
  change as changeTable,
  operation,
  runtimeAttempt,
  ticket,
} from "#db/schema";
import type { createChangeWriterController } from "../access/writer-api";
import { CommandError } from "../command-error";
import type { createRuntimeController } from "../runtime/api";
import type { RuntimeHub } from "../runtime/transport-api";
import type { RuntimeAttemptView } from "../runtime/types";
import { observedNativeSkillIds } from "../skills/api";
import type { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import type { createBuildBrowserController } from "./browser-controller";
import type { createAgentCandidates } from "./candidate-agent";
import type { createChangeAdmission } from "./change-admission";
import { createOpenCodeClient } from "./opencode-adapter";
import type { createReviewAdmission } from "./review-admission";
import { waitForBuildSandbox } from "./runtime-readiness";
import type { createSessionArchives } from "./session-archive-store";
import type { createChangeAgentStop, RetainedStopTarget } from "./stop";
import type { createAgentTurnStore } from "./turn-store";

export type Database = ReturnType<typeof createDatabase>;

export type RuntimeController = {
  startPersisted(changeID: string, userID: string): Promise<RuntimeAttemptView | null>;
  get?(attemptID: string): Promise<RuntimeAttemptView | null>;
  processAction?: ReturnType<typeof createRuntimeController>["processAction"];
};

export type AgentRow = {
  changeID: string;
  projectID: string;
  ticketID: string;
  ticketTitle: string;
  branchName: string;
  baseSHA: string;
  runtimeAttemptID: string;
  runtimeState: string;
  state: "starting" | "working" | "waiting" | "stopped" | "failed" | "committed";
  sessionID: string | null;
  sessionConfirmed: boolean;
  implementationSessionID: string | null;
  implementationSessionConfirmed: boolean;
  activeInboxID: string | null;
  lastError: string | null;
  activeTurnID: string | null;
  stopPending: boolean;
  stopID: string | null;
};

export type AgentBrowser = ReturnType<typeof createBuildBrowserController>;
export type AgentWriters = Pick<
  ReturnType<typeof createChangeWriterController>,
  "prepareAgent" | "confirmSource"
>;
export type RetainedStopSettler = (
  target: RetainedStopTarget,
  signal: AbortSignal,
) => Promise<boolean>;

export type AgentAdmission = ReturnType<typeof createChangeAdmission>;
export type AgentTurnStore = ReturnType<typeof createAgentTurnStore>;
export type AgentUsageJournal = ReturnType<typeof createRecordedOpenCodeUsage>;
export type AgentSessionArchives = ReturnType<typeof createSessionArchives>;
export type AgentCandidates = ReturnType<typeof createAgentCandidates>;
export type AgentStop = ReturnType<typeof createChangeAgentStop>;
export type AgentReviewAdmission = ReturnType<typeof createReviewAdmission>;

export type AgentActivity = {
  isClosed(): boolean;
  signal: AbortSignal;
  notifyActivity(changeID?: string): void;
  bindActivity(changeID: string, attemptID?: string): void;
  subscribeActivity(changeID: string, notify: () => void): () => void;
  subscribeAttemptEvents(attemptID: string, listener: (type: string) => void): () => void;
  run(work: Promise<void>): void;
  shutdown(): Promise<void>;
};

export type RenewExecution = (turnID: string, ownerToken: string) => Promise<boolean>;
export type ReconcileStop = (
  changeID: string,
  runtimeReady?: boolean,
  expectedStopID?: string,
) => Promise<void>;
export type MonitorTurn = (
  changeID: string,
  userID: string,
  turnID: string,
  ownerToken: string,
) => Promise<void>;
export type ExecuteTurn = (turnID: string) => Promise<void>;

export function opencode(hub: RuntimeHub, attemptID: string) {
  return createOpenCodeClient((request, path) => hub.request(attemptID, "agent", request, path));
}

export async function awaitConfiguredModel(
  client: ReturnType<typeof opencode>,
  modelID: string,
  authorized: () => Promise<boolean>,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await authorized()))
      throw new CommandError(
        "conflict",
        "Implementation startup was stopped or its authority changed",
      );
    try {
      await client.server.info({ signal: AbortSignal.timeout(2_000) });
      if (!(await authorized()))
        throw new CommandError("conflict", "Build authority changed during startup");
      const models = await client.model.list(undefined, { signal: AbortSignal.timeout(2_000) });
      if (models.data.some((model) => model.providerID === "factory" && model.id === modelID))
        return;
    } catch (cause) {
      if (cause instanceof CommandError) throw cause;
      // Only read-only readiness probes retry. No Session or prompt has been dispatched.
    }
    await Bun.sleep(500);
  }
  throw new Error(
    "OpenCode and the configured Factory model did not become ready. The IDE remains available.",
  );
}

export async function readAgentRow(
  database: Database,
  changeID: string,
  sql: Database["client"] | DatabaseTransaction = database.client,
): Promise<AgentRow | null> {
  const rows = await drizzleTransaction(sql)
    .select({
      changeID: changeTable.id,
      projectID: changeTable.projectId,
      ticketID: changeTable.ticketId,
      ticketTitle: ticket.title,
      branchName: changeTable.branchName,
      baseSHA: changeTable.baseSha,
      runtimeAttemptID: changeAgentSession.runtimeAttemptId,
      runtimeState: runtimeAttempt.state,
      state: changeAgentSession.state,
      sessionID: changeAgentSession.opencodeSessionId,
      sessionConfirmed: expression<boolean>`${changeAgentSession.nativeSessionConfirmedAt} IS NOT NULL`,
      implementationSessionID: expression<
        string | null
      >`COALESCE(${changeAgentSession.implementationSessionId},${changeAgentSession.opencodeSessionId})`,
      implementationSessionConfirmed: expression<boolean>`COALESCE(${changeAgentSession.implementationSessionConfirmedAt},${changeAgentSession.nativeSessionConfirmedAt}) IS NOT NULL`,
      activeInboxID: changeAgentSession.activeInboxId,
      lastError: changeAgentSession.lastError,
      activeTurnID: changeAgentSession.activeTurnId,
      stopPending: changeAgentSession.stopPending,
      stopID: changeAgentSession.stopId,
    })
    .from(changeAgentSession)
    .innerJoin(changeTable, eq(changeTable.id, changeAgentSession.changeId))
    .innerJoin(ticket, eq(ticket.id, changeTable.ticketId))
    .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
    .where(eq(changeAgentSession.changeId, changeID));
  return rows[0] ?? null;
}

export async function confirmNativeSession(
  database: Database,
  changeID: string,
  turnID: string,
  attemptID: string,
  sessionID: string,
) {
  const confirmed = await database.db
    .update(changeAgentSession)
    .set({
      nativeSessionConfirmedAt: expression`COALESCE(${changeAgentSession.nativeSessionConfirmedAt}, now())`,
      implementationSessionConfirmedAt: expression`CASE WHEN ${changeAgentSession.implementationSessionId} = ${sessionID}
        THEN COALESCE(${changeAgentSession.implementationSessionConfirmedAt}, now()) ELSE ${changeAgentSession.implementationSessionConfirmedAt} END`,
    })
    .where(
      and(
        eq(changeAgentSession.changeId, changeID),
        eq(changeAgentSession.activeTurnId, turnID),
        eq(changeAgentSession.runtimeAttemptId, attemptID),
        eq(changeAgentSession.opencodeSessionId, sessionID),
        ne(changeAgentSession.state, "stopped"),
        not(changeAgentSession.stopPending),
      ),
    )
    .returning({ id: changeAgentSession.changeId });
  if (confirmed.length !== 1)
    throw new CommandError("conflict", "Native Session confirmation no longer matches this Build");
}

export async function readCurrentChange(database: Database, changeID: string) {
  const rows = await database.db
    .select({
      changeID: changeTable.id,
      runtimeAttemptID: changeTable.runtimeAttemptId,
      branchName: changeTable.branchName,
      declaredApps: expression<string[]>`COALESCE(${runtimeAttempt.declaredApps},'[]'::jsonb)`,
      runtimeState: runtimeAttempt.state,
      changeState: changeTable.state,
    })
    .from(changeTable)
    .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeTable.runtimeAttemptId))
    .where(eq(changeTable.id, changeID));
  const change = rows[0];
  if (!change) throw new CommandError("not-found", "Change not found");
  if (!["active", "starting"].includes(change.changeState)) {
    if (
      change.changeState === "failed" &&
      ["failed", "stopped", "cleanup-failed"].includes(change.runtimeState ?? "")
    )
      throw new CommandError(
        "unavailable",
        "The Ticket Workspace failed to start. Source is retained. Retry the interrupted operation from this Ticket.",
      );
    throw new CommandError("conflict", "Change is not active");
  }
  return change;
}

export async function awaitReadyChange(
  database: Database,
  changeID: string,
  turnID: string,
  attemptID: string,
  isClosed: () => boolean,
) {
  return waitForBuildSandbox(
    attemptID,
    async () => {
      const session = await readAgentRow(database, changeID);
      const change = await readCurrentChange(database, changeID);
      return {
        active:
          session?.state === "starting" && session.activeTurnID === turnID && !session.stopPending,
        runtimeAttemptID: change.runtimeAttemptID,
        runtimeState: change.runtimeState,
      };
    },
    isClosed,
  );
}

export async function recordNativeSkillLoads(
  database: Database,
  admission: AgentAdmission,
  turns: AgentTurnStore,
  turnID: string,
  ownerToken: string,
  promptID: string | null,
  messages: readonly unknown[],
) {
  if (!promptID) return;
  const intent = await admission.intent(turnID);
  if (intent.skillManifest === null) return;
  const [turn] = await database.db
    .select({
      ids: expression<
        string[]
      >`ARRAY(SELECT jsonb_array_elements_text(${agentTurn.authority}->'skillRevisionIds'))`,
    })
    .from(agentTurn)
    .where(eq(agentTurn.id, turnID));
  const loaded = observedNativeSkillIds(messages, promptID, turn?.ids ?? []);
  if (loaded.length)
    await turns.validateExecution(turnID, ownerToken, async (sql) => {
      for (const id of loaded)
        await drizzleTransaction(sql)
          .insert(operation)
          .values({
            id: crypto.randomUUID(),
            kind: "coding.turn_skill",
            scopeType: "agent_turn",
            scopeId: turnID,
            idempotencyKey: `coding.turn_skill:${turnID}:${id}`,
            activeKey: null,
            state: "loaded",
            payload: {
              turnId: turnID,
              revisionId: id,
              loadedAt: new Date().toISOString(),
            },
          })
          .onConflictDoNothing({ target: operation.idempotencyKey });
    });
}
