import { factorySigningSecret } from "../../../../packages/auth/src/signing-secret";
import {
  candidateReviewPermissions,
  candidateReviewResultInput,
} from "../../../../packages/conversation-domain/src/candidate-review";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  agentTurnSkill,
  candidateReview,
  change as changeTable,
  changeAgentSession,
  changeAgentTurnIntent,
  changeCommitOperation,
  codingPause,
  conversationContext,
  executionPolicyCommand,
  runtimeAttempt,
  runtimeComputeWait,
  ticket,
  ticketConversation,
} from "../../../../packages/db/src/schema";
import { nativeLifecycleWindowMS } from "../../../../packages/runtime-domain/src/timing";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import type { createChangeWriterController } from "../access/writer-controller";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { createOpenBaoModelSecrets } from "../models/secrets";
import type { createRuntimeController } from "../runtime/controller";
import type { RuntimeHub } from "../runtime/hub";
import type { RuntimeAttemptView } from "../runtime/types";
import { nativeSkillManifestInput, observedNativeSkillIds } from "../skills/native";
import { codingAllowanceDenial } from "../usage/opencode";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import { personalGitStatus } from "../workspace/personal-git";
import type { createBuildBrowserController } from "./browser-controller";
import { earlierSubmissionUnchanged, noChangesToSubmit } from "./candidate";
import { createAgentCandidates } from "./candidate-agent";
import { createChangeAdmission } from "./change-admission";
import { createChangeAgentTransport } from "./change-transport";
import { createCodingContexts } from "./conversation-contexts";
import { navigationMessages, projectMessages } from "./message-projection";
import { bounded, readableError } from "./native-errors";
import { connectOpenCodeBrowser, connectOpenCodeSources } from "./opencode-browser";
import {
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  ensureOpenCodeMessageBoundary,
  interruptOpenCodeSession,
  isOpenCodeObservationTransportError,
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
  syncOpenCodeInputGuidance,
} from "./opencode-client";
import { createActivityWake, createOpenCodeEvents } from "./opencode-events";
import { checkTerminalOpenCodeInbox } from "./opencode-terminal";
import { observeOpenCodeUsage } from "./opencode-usage";
import { createReviewAdmission } from "./review-admission";
import { waitForBuildSandbox } from "./runtime-readiness";
import { createSessionArchives } from "./session-archive-store";
import { createChangeAgentStop, type PendingWriterHandoff, type RetainedStopTarget } from "./stop";
import { captureTerminalOutcome, validateTerminalMessages } from "./terminal-outcome";
import { readTurnObservation } from "./turn-observation";
import { classifyAgentTurn } from "./turn-outcome";
import { type AgentTurnRecord, createAgentTurnStore } from "./turn-store";

type Database = ReturnType<typeof createDatabase>;
type RuntimeController = {
  startPersisted(changeID: string, userID: string): Promise<RuntimeAttemptView | null>;
  get?(attemptID: string): Promise<RuntimeAttemptView | null>;
  processAction?: ReturnType<typeof createRuntimeController>["processAction"];
};
type AgentRow = {
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

const workspaceDirectory = "/workspace/project";

function opencode(hub: RuntimeHub, attemptID: string) {
  return createOpenCodeClient((request, path) => hub.request(attemptID, "agent", request, path));
}

async function awaitConfiguredModel(
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
      const models = await client.model.list(
        { location: { directory: workspaceDirectory } },
        { signal: AbortSignal.timeout(2_000) },
      );
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

export function createAgentController(
  database: Database,
  hub: RuntimeHub,
  runtime: RuntimeController,
  browser?: ReturnType<typeof createBuildBrowserController>,
  writers?: Pick<ReturnType<typeof createChangeWriterController>, "prepareAgent" | "confirmSource">,
  settleRetainedStop?: (target: RetainedStopTarget, signal: AbortSignal) => Promise<boolean>,
) {
  const monitors = new Set<string>();
  const observationController = new AbortController();
  const nativeEvents = createOpenCodeEvents((attemptID) => opencode(hub, attemptID));
  const activityListeners = new Map<
    string,
    Set<{
      notify(): void;
      attemptID?: string;
      detach?: () => void;
    }>
  >();
  function notifyActivity(changeID?: string) {
    for (const [id, listeners] of activityListeners)
      if (!changeID || id === changeID) for (const listener of listeners) listener.notify();
  }
  function bindActivity(changeID: string, attemptID?: string) {
    if (closed) return;
    for (const listener of activityListeners.get(changeID) ?? []) {
      if (listener.attemptID === attemptID) continue;
      const detach = attemptID ? nativeEvents.subscribe(attemptID, listener.notify) : undefined;
      listener.detach?.();
      if (attemptID) listener.attemptID = attemptID;
      else delete listener.attemptID;
      if (detach) listener.detach = detach;
      else delete listener.detach;
    }
  }
  const starters = new Set<string>();
  const recovering = new Set<string>();
  const turns = createAgentTurnStore(database);
  async function recordNativeSkillLoads(
    turnID: string,
    ownerToken: string,
    promptID: string | null,
    messages: readonly unknown[],
  ) {
    if (!promptID) return;
    const intent = await admission.intent(turnID);
    if (intent.skillLoading !== "native") return;
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
            .insert(agentTurnSkill)
            .values({ turnId: turnID, revisionId: id })
            .onConflictDoNothing();
      });
  }
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
    settleRetainedStop
      ? (target) => settleRetainedStop(target, observationController.signal)
      : undefined,
    runtime.get?.bind(runtime),
  );
  const admitReview = createReviewAdmission(database, async (sql, context) => {
    const modelId = await modelSettings.resolve("build", sql, { ...context, personal: false });
    const modelConnection = await modelConnections.reference("build", sql);
    return { modelId, ...(modelConnection ? { modelConnection } : {}) };
  });
  const background = new Set<Promise<void>>();
  let closed = false;
  const candidates = createAgentCandidates(database, hub, () => closed);

  function run(work: Promise<void>) {
    background.add(work);
    void work.catch(reportFailure("Background agent work")).finally(() => {
      background.delete(work);
      notifyActivity();
    });
  }

  async function row(
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

  async function confirmNativeSession(
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
      throw new CommandError(
        "conflict",
        "Native Session confirmation no longer matches this Build",
      );
  }

  async function currentChange(changeID: string) {
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

  async function awaitReadyChange(changeID: string, turnID: string, attemptID: string) {
    return waitForBuildSandbox(
      attemptID,
      async () => {
        const session = await row(changeID);
        const change = await currentChange(changeID);
        return {
          active:
            session?.state === "starting" &&
            session.activeTurnID === turnID &&
            !session.stopPending,
          runtimeAttemptID: change.runtimeAttemptID,
          runtimeState: change.runtimeState,
        };
      },
      () => closed,
    );
  }

  async function execute(turnID: string) {
    if (closed || starters.has(turnID)) return;
    starters.add(turnID);
    let owned: AgentTurnRecord | null = null;
    let renew: ReturnType<typeof setInterval> | undefined;
    let pendingRenewal: Promise<void> | undefined;
    let dispatched = false;
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
      const ownerToken = owned.ownerToken;
      const userID = owned.command.createdBy;
      const skillRevisionIDs = owned.authority.skillRevisionIds;
      const changeID = owned.command.changeId;
      const intent = await admission.intent(turnID);
      renew = setInterval(() => {
        if (closed || pendingRenewal) return;
        pendingRenewal = renewExecution(turnID, ownerToken)
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            pendingRenewal = undefined;
          });
      }, 10_000);
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
      let current = await currentChange(changeID);
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
        current = await currentChange(changeID);
      }
      if (!current.runtimeAttemptID) throw new Error("Ticket Sandbox was not created");
      const attemptID = current.runtimeAttemptID;
      const prepared = await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const active = await db
          .select({ id: agentTurn.id })
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, turnID),
              eq(agentTurn.state, "pending"),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .for("update");
        if (!active[0]) return false;
        await db
          .update(changeAgentTurnIntent)
          .set({ runtimeAttemptId: attemptID })
          .where(
            and(
              eq(changeAgentTurnIntent.turnId, turnID),
              isNull(changeAgentTurnIntent.runtimeAttemptId),
            ),
          );
        const implementationSessionID =
          owned?.authority.mode === "build" && owned.authority.review ? null : intent.sessionID;
        await db
          .insert(changeAgentSession)
          .values({
            changeId: changeID,
            runtimeAttemptId: attemptID,
            opencodeSessionId: intent.sessionID,
            state: "starting",
            createdBy: userID,
            activeTurnId: turnID,
            implementationSessionId: implementationSessionID,
          })
          .onConflictDoUpdate({
            target: changeAgentSession.changeId,
            set: {
              runtimeAttemptId: attemptID,
              implementationSessionId: expression`COALESCE(${implementationSessionID}::text,${changeAgentSession.implementationSessionId},${changeAgentSession.opencodeSessionId})`,
              implementationSessionConfirmedAt: expression`COALESCE(${changeAgentSession.implementationSessionConfirmedAt},
              CASE WHEN ${changeAgentSession.implementationSessionId} IS NULL THEN ${changeAgentSession.nativeSessionConfirmedAt} END)`,
              nativeSessionConfirmedAt: expression`CASE WHEN ${changeAgentSession.opencodeSessionId} IS NOT DISTINCT FROM ${intent.sessionID}::text
              THEN ${changeAgentSession.nativeSessionConfirmedAt} END`,
              opencodeSessionId: intent.sessionID,
              state: "starting",
              activeTurnId: turnID,
              activeInboxId: null,
              lastError: null,
              updatedAt: expression`now()`,
            },
          });
        return true;
      });
      if (!prepared) return;
      if (
        (
          await database.db
            .select({ id: runtimeComputeWait.attemptId })
            .from(runtimeComputeWait)
            .where(eq(runtimeComputeWait.attemptId, attemptID))
        ).length
      ) {
        await turns.releasePending(turnID, ownerToken);
        return;
      }
      const change = await awaitReadyChange(changeID, turnID, attemptID);
      const client = createOpenCodeClient(
        createChangeAgentTransport(database, hub, change.runtimeAttemptID, turnID, ownerToken),
      );
      await awaitConfiguredModel(client, owned.authority.modelId, () =>
        closed ? Promise.resolve(false) : turns.validateExecution(turnID, ownerToken),
      );
      if (intent.skillLoading === "native") {
        const manifest = nativeSkillManifestInput.parse(intent.skillManifest);
        if (manifest.files.length > 0)
          await hub.parentOperation(
            attemptID,
            {
              operationId: `${attemptID}-skills-${manifest.digest}`,
              action: "skills-install",
              data: JSON.stringify(manifest),
            },
            async (send) => {
              if (
                !(await turns.validateExecution(turnID, ownerToken, async () => {
                  send();
                }))
              )
                throw new CommandError(
                  "conflict",
                  "Build authority changed before skill installation",
                );
            },
          );
        const expected = skillRevisionIDs.map((id) => `factory-${id}`).sort();
        let ready = false;
        for (let probe = 0; probe < 40; probe++) {
          const observed = (
            await client.skill.list({ location: { directory: workspaceDirectory } })
          ).data
            .filter((item) => !item.path.startsWith("/builtin/"))
            .map((item) => item.id)
            .sort();
          if (JSON.stringify(observed) === JSON.stringify(expected)) {
            ready = true;
            break;
          }
          await Bun.sleep(250);
        }
        if (!ready) throw new Error("Native skills do not match the exact admitted packages");
      }
      // Initial role initialization may have preceded the first Source Parent.
      // A real current-epoch read-only fence is mandatory here, including when
      // the runtime was already ready or a previous restore used an old epoch.
      await writers.confirmSource(changeID, turnID, ownerToken, attemptID, intent.sessionID);
      if (!(await turns.beginDispatch(turnID, ownerToken))) {
        if (
          (
            await database.db
              .select({ id: codingPause.turnId })
              .from(codingPause)
              .where(and(eq(codingPause.turnId, turnID), isNull(codingPause.resumedByTurnId)))
          ).length
        )
          return;
        throw new CommandError("conflict", "Build authority changed before dispatch");
      }
      dispatched = true;
      if (owned.authority.review) {
        const apps = current.declaredApps;
        const advertised = hub.appChannels(attemptID);
        if (apps.length !== advertised.length || apps.some((app) => !advertised.includes(app)))
          throw new CommandError("unavailable", "Review declared Apps are not connected");
        if (apps.length) {
          if (!runtime.processAction)
            throw new CommandError("unavailable", "Review App preparation is not configured");
          const beforeSend = async (send: () => void) => {
            if (
              !(await turns.validateExecution(turnID, ownerToken, async (sql) => {
                observationController.signal.throwIfAborted();
                if (apps.some((app) => !hub.hasAppChannel(attemptID, app)))
                  throw new CommandError("unavailable", "Review declared Apps are not connected");
                const [current] = await sql`
                  SELECT intent.turn_id FROM factory.change_agent_turn_intent intent
                  JOIN factory.agent_turn turn ON turn.id=intent.turn_id
                  JOIN factory.change change ON change.id=intent.change_id
                  JOIN factory.change_agent_session session ON session.change_id=change.id
                  JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
                  JOIN factory.change_writer writer ON writer.change_id=change.id
                  WHERE intent.turn_id=${turnID} AND intent.session_id=${intent.sessionID}
                    AND intent.runtime_attempt_id=${attemptID} AND change.runtime_attempt_id=${attemptID}
                    AND session.runtime_attempt_id=${attemptID} AND session.active_turn_id=${turnID}
                    AND session.opencode_session_id=${intent.sessionID} AND session.state='starting'
                    AND NOT session.stop_pending AND attempt.state='ready' AND attempt.stop_intended_at IS NULL
                    AND writer.state='agent' AND writer.turn_id=${turnID} AND NOT writer.fence_required
                    AND turn.owner_token=${ownerToken} AND turn.owner_expires_at>clock_timestamp()
                  FOR SHARE OF attempt,session`;
                if (!current)
                  throw new CommandError(
                    "conflict",
                    "Review Runtime Attempt changed before App preparation",
                  );
                send();
              }))
            )
              throw new CommandError("conflict", "Review authority changed before App preparation");
          };
          const candidate = owned.authority.review.commitSha;
          const confirmCheckout = async () => {
            const status = await hub.parentOperation(
              attemptID,
              {
                operationId: crypto.randomUUID(),
                action: "workspace-git",
                data: JSON.stringify({ action: "status", branch: current.branchName }),
              },
              beforeSend,
            );
            const checkout = personalGitStatus.parse(JSON.parse(status.data ?? "null"));
            if (
              checkout.head !== candidate ||
              checkout.branch !== current.branchName ||
              checkout.files.length
            )
              throw new CommandError("conflict", "Review App needs the clean submitted candidate");
          };
          await confirmCheckout();
          // Non-watch commands still hold bootstrap code after submission.
          // Refresh before creating the independent Session. An unknown effect
          // leaves no Session for recovery to resume and is never replayed.
          const signal = AbortSignal.any([
            observationController.signal,
            AbortSignal.timeout(nativeLifecycleWindowMS),
          ]);
          for (const app of apps)
            await runtime.processAction(attemptID, app, "restart", {
              beforeSend,
              waitForReady: true,
              signal,
            });
          await confirmCheckout();
          if (!(await turns.validateExecution(turnID, ownerToken)))
            throw new CommandError("conflict", "Review authority changed during App preparation");
        }
      }
      const session = intent.bootstrap
        ? await client.session.create({
            id: intent.sessionID,
            title: intent.title,
            location: { directory: workspaceDirectory },
            model: { providerID: "factory", id: owned.authority.modelId },
            permissions: owned.authority.review
              ? candidateReviewPermissions
              : [
                  { action: "*", resource: "*", effect: "allow" },
                  ...(intent.skillLoading === "native"
                    ? [
                        { action: "skill", resource: "*", effect: "deny" as const },
                        ...skillRevisionIDs.map((id) => ({
                          action: "skill",
                          resource: `factory-${id}`,
                          effect: "allow" as const,
                        })),
                      ]
                    : []),
                ],
          })
        : await client.session.get({ sessionID: intent.sessionID });
      if (
        session.id !== intent.sessionID ||
        session.location.directory !== workspaceDirectory ||
        session.model?.providerID !== "factory" ||
        session.model.id !== owned.authority.modelId
      ) {
        throw new Error("The retained OpenCode session does not match its recorded configuration");
      }
      await confirmNativeSession(changeID, turnID, attemptID, intent.sessionID);
      if (!(await turns.validateExecution(turnID, ownerToken)))
        throw new CommandError("conflict", "Build authority changed before prompt submission");
      await ensureOpenCodeMessageBoundary(client, intent.sessionID);
      await usageJournal.prepare(turnID, client, intent.sessionID);
      if (intent.skillLoading === "native") await syncOpenCodeInputGuidance(client, intent);
      if (owned.authority.review)
        await client.session.instructions.entry.put({
          sessionID: intent.sessionID,
          key: "factory-review-policy",
          value: intent.text,
        });
      const browserGrant = await browser?.prepare(turnID, ownerToken);
      if (intent.browserTransport === "mcp" && browserGrant)
        await connectOpenCodeBrowser(
          client,
          browserGrant.runtimeEndpoint,
          browserGrant.runtimeBearer,
        );
      if (!owned.authority.review && browserGrant)
        await connectOpenCodeSources(
          client,
          browserGrant.runtimeEndpoint,
          browserGrant.runtimeBearer,
        );
      const inbox = await promptRecordedOpenCodeInput(client, intent, true);
      if (inbox.id !== intent.promptID)
        throw new Error("OpenCode returned another prompt identity");
      const running = await turns.markRunning(turnID, ownerToken, async (sql) => {
        const db = drizzleTransaction(sql);
        for (const revisionID of intent.skillLoading === "eager" ? skillRevisionIDs : []) {
          await db
            .insert(agentTurnSkill)
            .values({ turnId: turnID, revisionId: revisionID })
            .onConflictDoNothing();
        }
        const rows = await db
          .update(changeAgentSession)
          .set({
            state: "working",
            activeInboxId: intent.promptID,
            lastError: null,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(changeAgentSession.changeId, changeID),
              eq(changeAgentSession.state, "starting"),
              eq(changeAgentSession.activeTurnId, turnID),
            ),
          )
          .returning({ id: changeAgentSession.changeId });
        if (!rows[0])
          throw new CommandError("conflict", "Build ownership changed before recording dispatch");
        if (owned?.authority.mode === "build" && owned.authority.review)
          await db
            .update(candidateReview)
            .set({ state: "running" })
            .where(
              and(
                eq(candidateReview.id, owned.authority.review.reviewId),
                eq(candidateReview.turnId, turnID),
                eq(candidateReview.state, "pending"),
              ),
            );
      });
      if (!running) {
        // The accepted prompt may still be running, or Stop may already have
        // released this Session to another turn. Only settle our owned record;
        // a late response must never interrupt the Session's newer work.
        throw new CommandError("conflict", "Build authority changed after prompt acceptance");
      }
      // Keep the independent renewal timer alive while monitoring this exact turn.
      await monitor(changeID, userID, owned.id, ownerToken);
    } catch (cause) {
      if (closed) return;
      if (owned?.ownerToken && "changeId" in owned.command) {
        const summary = bounded(readableError(cause), 2_000);
        let changed = dispatched
          ? await turns.settle(turnID, owned.ownerToken, "uncertain", summary)
          : await turns.failPending(turnID, owned.ownerToken, summary);
        if (!changed && startupRejected)
          changed = await turns.failUnboundStartup(turnID, owned.ownerToken, summary);
        if (changed)
          await database.db
            .update(changeAgentSession)
            .set({
              state: "failed",
              lastError: dispatched
                ? `Execution outcome uncertain. Stop or resolve this turn before new Build work. ${summary}`
                : summary,
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(changeAgentSession.activeTurnId, turnID),
                inArray(changeAgentSession.state, ["starting", "working"]),
              ),
            );
      }
    } finally {
      if (renew) clearInterval(renew);
      await pendingRenewal;
      await browser?.closeTurn(turnID);
      starters.delete(turnID);
    }
  }

  async function recoverExternal(turnID: string) {
    if (closed || recovering.has(turnID) || monitors.has(turnID) || starters.has(turnID)) return;
    recovering.add(turnID);
    let owned: AgentTurnRecord | null = null;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let pendingRenewal: Promise<void> | undefined;
    try {
      // A restarted Factory may arrive before the dead process's lease expires.
      // Wait for that lease, never infer process death merely from startup.
      for (let observation = 0; observation < 60 && !closed; observation += 1) {
        const current = await turns.get(turnID);
        if (!current || !["dispatching", "running", "uncertain"].includes(current.state)) return;
        owned = await turns.claimExternalRecovery(turnID);
        if (owned) break;
        await Bun.sleep(1_000);
      }
      if (!owned?.ownerToken || owned.authority.mode !== "build" || !("changeId" in owned.command))
        return;
      const ownerToken = owned.ownerToken;
      const changeID = owned.command.changeId;
      const intent = await admission.intent(turnID);
      renewal = setInterval(() => {
        if (closed || pendingRenewal) return;
        pendingRenewal = renewExecution(turnID, ownerToken)
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            pendingRenewal = undefined;
          });
      }, 10_000);
      if (!writers)
        throw new CommandError("unavailable", "Change writer enforcement is not configured");
      if (!(await writers.prepareAgent(changeID, turnID)))
        throw new CommandError(
          "conflict",
          "Previous Workspace commands have not stopped during execution recovery",
        );
      const skillRevisionIDs = owned.authority.skillRevisionIds;
      let queueWakeRequested = false;
      while (!closed) {
        if (!(await turns.renew(turnID, ownerToken))) {
          throw new CommandError("conflict", "Build authority changed before external recovery");
        }
        if (!(await turns.validateExecution(turnID, ownerToken)))
          throw new CommandError("conflict", "Build authority changed before external recovery");
        const session = await row(changeID);
        const current = await currentChange(changeID);
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
          const retained = await client.session.get(
            { sessionID: intent.sessionID },
            { signal: AbortSignal.any([observationController.signal, AbortSignal.timeout(5_000)]) },
          );
          if (
            retained.id !== intent.sessionID ||
            retained.location.directory !== workspaceDirectory ||
            retained.model?.providerID !== "factory" ||
            retained.model.id !== owned.authority.modelId
          )
            throw new Error("Recovered OpenCode session does not match its recorded configuration");
          if ((await admission.terminalObservation(intent)).terminal) {
            // A durable terminal observation closes inference, including after
            // process loss. Do not re-admit/wake its input or recreate grants.
            let restored = false;
            const allowed = await turns.validateExecution(turnID, ownerToken, async (sql) => {
              const db = drizzleTransaction(sql);
              const rows = await db
                .update(changeAgentSession)
                .set({
                  state: "working",
                  lastError: null,
                  updatedAt: expression`now()`,
                })
                .where(
                  and(
                    eq(changeAgentSession.changeId, changeID),
                    eq(changeAgentSession.activeTurnId, turnID),
                    eq(changeAgentSession.activeInboxId, intent.promptID),
                    ne(changeAgentSession.state, "stopped"),
                    not(changeAgentSession.stopPending),
                    expression`${changeAgentSession.runtimeAttemptId} = ${intent.attemptID}::uuid`,
                    eq(changeAgentSession.opencodeSessionId, intent.sessionID),
                    exists(
                      db
                        .select({ id: agentTurn.id })
                        .from(agentTurn)
                        .where(
                          and(
                            eq(agentTurn.id, turnID),
                            eq(agentTurn.state, "running"),
                            eq(agentTurn.ownerToken, ownerToken),
                            gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
                          ),
                        ),
                    ),
                  ),
                )
                .returning({ id: changeAgentSession.changeId });
              restored = rows.length === 1;
            });
            if (!allowed || !restored) return;
            await monitor(changeID, owned.command.createdBy, turnID, ownerToken);
            return;
          }
          if (intent.skillLoading === "native") await syncOpenCodeInputGuidance(client, intent);
          if (owned.authority.review)
            await client.session.instructions.entry.put({
              sessionID: intent.sessionID,
              key: "factory-review-policy",
              value: intent.text,
            });
          await usageJournal.drain(turnID, client, intent.sessionID);
          [work, messages] = await Promise.all([
            observeOpenCodeWork(client, intent.sessionID),
            readOpenCodeInputMessages(
              client,
              intent.sessionID,
              intent.promptID,
              AbortSignal.any([observationController.signal, AbortSignal.timeout(5_000)]),
            ),
          ]);
        } catch (cause) {
          if (!isOpenCodeObservationTransportError(cause)) throw cause;
          // These reads and exact idempotent guidance bindings may repeat,
          // never inference. Recheck Stop, ownership and runtime next time.
          await Bun.sleep(1_000);
          continue;
        }
        await confirmNativeSession(changeID, turnID, intent.attemptID, intent.sessionID);
        const browserGrant = await browser?.prepare(turnID, ownerToken);
        if (intent.browserTransport === "mcp" && browserGrant)
          await connectOpenCodeBrowser(
            client,
            browserGrant.runtimeEndpoint,
            browserGrant.runtimeBearer,
          );
        if (!owned.authority.review && browserGrant)
          await connectOpenCodeSources(
            client,
            browserGrant.runtimeEndpoint,
            browserGrant.runtimeBearer,
          );
        await recordNativeSkillLoads(turnID, ownerToken, intent.promptID, messages.data);
        const input = messages.data.find(
          (message) => message.type === "user" && message.id === intent.promptID,
        );
        if (!input) {
          // The exact deterministic admission may still be queued, or dispatch
          // may have stopped before admission. This endpoint can admit missing
          // input, so revalidate execution rather than treating it as a read.
          if (!(await turns.validateExecution(turnID, ownerToken)))
            throw new CommandError("conflict", "Build authority changed before queue admission");
          await ensureOpenCodeMessageBoundary(client, intent.sessionID);
          await usageJournal.prepare(turnID, client, intent.sessionID);
          const admitted = await promptRecordedOpenCodeInput(client, intent, false);
          if (admitted.state === "queued" && !queueWakeRequested) {
            const latest = await currentChange(changeID);
            const latestSession = await row(changeID);
            if (
              latest.runtimeAttemptID !== intent.attemptID ||
              latest.runtimeState !== "ready" ||
              latestSession?.activeTurnID !== turnID ||
              latestSession.sessionID !== intent.sessionID ||
              latestSession.state === "stopped" ||
              !hub.connected(intent.attemptID) ||
              !(await turns.validateExecution(turnID, ownerToken))
            )
              throw new CommandError("conflict", "Build authority changed before queue wake");
            // Pinned wake drains pending input only. It is not the explicit
            // Session resume that can force another provider attempt. Reusing
            // the exact ID also cannot add a second input if promotion races us.
            await promptRecordedOpenCodeInput(client, intent, true);
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
          !(await turns.validateExecution(turnID, ownerToken, async (sql) => {
            for (const revisionID of intent.skillLoading === "eager" ? skillRevisionIDs : []) {
              await drizzleTransaction(sql)
                .insert(agentTurnSkill)
                .values({ turnId: turnID, revisionId: revisionID })
                .onConflictDoNothing();
            }
          }))
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
        const restored = await database.db
          .update(changeAgentSession)
          .set({
            state: "working",
            activeInboxId: intent.promptID,
            lastError: null,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(changeAgentSession.changeId, changeID),
              eq(changeAgentSession.activeTurnId, turnID),
              ne(changeAgentSession.state, "stopped"),
              eq(changeAgentSession.runtimeAttemptId, intent.attemptID),
              eq(changeAgentSession.opencodeSessionId, intent.sessionID),
              exists(
                database.db
                  .select({ id: agentTurn.id })
                  .from(agentTurn)
                  .where(
                    and(
                      eq(agentTurn.id, turnID),
                      eq(agentTurn.state, "running"),
                      eq(agentTurn.ownerToken, ownerToken),
                      gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
                    ),
                  ),
              ),
            ),
          )
          .returning({ id: changeAgentSession.changeId });
        if (!restored[0]) return;
        await monitor(changeID, owned.command.createdBy, turnID, ownerToken);
        return;
      }
    } catch (cause) {
      if (closed) return;
      if (owned?.ownerToken && "changeId" in owned.command) {
        const summary = bounded(readableError(cause), 2_000);
        if (await turns.settle(turnID, owned.ownerToken, "uncertain", summary)) {
          await database.db
            .update(changeAgentSession)
            .set({ state: "failed", lastError: summary, updatedAt: expression`now()` })
            .where(
              and(
                eq(changeAgentSession.changeId, owned.command.changeId),
                eq(changeAgentSession.activeTurnId, turnID),
                ne(changeAgentSession.state, "stopped"),
                exists(
                  database.db
                    .select({ id: agentTurn.id })
                    .from(agentTurn)
                    .where(and(eq(agentTurn.id, turnID), eq(agentTurn.state, "uncertain"))),
                ),
              ),
            );
        }
      }
    } finally {
      if (renewal) clearInterval(renewal);
      await pendingRenewal;
      await browser?.closeTurn(turnID);
      recovering.delete(turnID);
    }
  }

  async function renewExecution(turnID: string, ownerToken: string) {
    const renewed = await turns.renew(turnID, ownerToken);
    // Browser renewal coalesces per turn and can await slow owned cleanup.
    // Join it as background work without occupying the owner keepalive.
    if (renewed && !closed && browser) run(browser.renewTurn(turnID, ownerToken));
    return renewed;
  }

  async function monitor(changeID: string, userID: string, turnID: string, ownerToken: string) {
    if (closed || monitors.has(turnID)) return;
    monitors.add(turnID);
    let inactiveObservations = 0;
    const wake = createActivityWake(observationController.signal);
    let detach: (() => void) | undefined;
    try {
      const intent = await admission.intent(turnID);
      const initial = await row(changeID);
      if (!initial?.sessionID) return;
      const client = createOpenCodeClient(
        createChangeAgentTransport(database, hub, initial.runtimeAttemptID, turnID, ownerToken),
      );
      detach = nativeEvents.subscribe(initial.runtimeAttemptID, (type) => {
        // Token deltas update the panel, not durable usage/settlement reads.
        if (!type.endsWith(".delta") && type !== "session.tool.progress") wake.notify();
      });
      while (!closed) {
        const revision = wake.revision();
        const session = await row(changeID);
        if (!session?.sessionID || session.activeTurnID !== turnID) return;
        if (session.state === "stopped") {
          run(reconcileStop(changeID));
          return;
        }
        if (session.state !== "working") return;
        if (!(await renewExecution(turnID, ownerToken))) {
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
            run(reconcileStop(changeID));
          }
          return;
        }
        const latestSession = await row(changeID);
        if (latestSession?.state !== "working" || latestSession.activeTurnID !== turnID) return;
        if (["failed", "stopped", "cleanup-failed"].includes(session.runtimeState)) {
          throw new Error("The Ticket Workspace stopped during implementation");
        }
        if (!hub.connected(session.runtimeAttemptID) || session.runtimeState !== "ready") {
          await Bun.sleep(1_000);
          continue;
        }
        try {
          if (session.runtimeAttemptID !== initial.runtimeAttemptID) return;
          // Sample before native work/history. Relay dispatch advances this
          // epoch under the same Turn lock used to persist the checkpoint.
          const terminalObservation = await admission.terminalObservation(intent);
          const work = await observeOpenCodeWork(client, session.sessionID);
          const [, messages] = await Promise.all([
            usageJournal.drain(turnID, client, session.sessionID, work.sessionIDs),
            readOpenCodeInputMessages(
              client,
              session.sessionID,
              intent.promptID,
              AbortSignal.any([observationController.signal, AbortSignal.timeout(5_000)]),
            ),
          ]);
          await recordNativeSkillLoads(turnID, ownerToken, session.activeInboxID, messages.data);
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
          let outcome: ReturnType<typeof classifyAgentTurn> = { state: "pending" };
          if (checkpoint) {
            outcome = validateTerminalMessages(checkpoint, intent, messages.data);
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
            await checkTerminalOpenCodeInbox(client, session.sessionID, checkpoint.shells);
            if (work.running) {
              // Only the checkpoint phase may interrupt post-terminal native
              // wakeups: its relay fence prevents further provider admission.
              if (!(await renewExecution(turnID, ownerToken))) continue;
              if ((await interruptOpenCodeSession(client, session.sessionID)) === "unconfirmed")
                throw new Error(
                  "OpenCode finished but its background shell cleanup is unconfirmed",
                );
              await checkTerminalOpenCodeInbox(client, session.sessionID, checkpoint.shells, true);
              // Confirm through fresh execution/history reads on the next loop.
              continue;
            }
            await checkTerminalOpenCodeInbox(client, session.sessionID, checkpoint.shells, true);
            if (!(await confirmSettledOpenCodeInput(client, session.sessionID, intent.promptID)))
              throw new Error("OpenCode terminal input and its execution tree are not settled");
            // A new input can have been promoted during cleanup. Quiescence
            // alone does not establish that the exact input still owns history.
            const settledMessages = await readOpenCodeInputMessages(
              client,
              session.sessionID,
              intent.promptID,
              AbortSignal.any([observationController.signal, AbortSignal.timeout(5_000)]),
            );
            outcome = validateTerminalMessages(checkpoint, intent, settledMessages.data);
            if (!(await confirmSettledOpenCodeInput(client, session.sessionID, intent.promptID)))
              throw new Error("OpenCode work changed during the terminal history confirmation");
            if (closed) return;
          }
          if (closed) return;
          // History can observe a terminal outcome after the earlier log watermark.
          // Drain again before settlement so the last paid step cannot be missed.
          if (outcome.state === "failed" || outcome.state === "succeeded")
            await usageJournal.drain(turnID, client, session.sessionID);
          if (outcome.state === "failed") {
            const pause = await database.db
              .select({ id: codingPause.turnId })
              .from(codingPause)
              .where(and(eq(codingPause.turnId, turnID), isNull(codingPause.resumedByTurnId)));
            await usageJournal.settle(
              turnID,
              "failed",
              Boolean(pause.length) && readableError(outcome.error).includes(codingAllowanceDenial),
            );
            const summary = pause.length
              ? "Coding paused at its allowance. Existing code is retained. Resume explicitly after reset or an allowance increase."
              : bounded(readableError(outcome.error), 2_000);
            await turns.settle(turnID, ownerToken, "failed", summary);
            await database.db
              .update(changeAgentSession)
              .set({ state: "failed", lastError: summary, updatedAt: expression`now()` })
              .where(
                and(
                  eq(changeAgentSession.changeId, changeID),
                  eq(changeAgentSession.state, "working"),
                  eq(changeAgentSession.activeTurnId, turnID),
                  expression`${changeAgentSession.activeInboxId} = ${session.activeInboxID}::text`,
                  exists(
                    database.db
                      .select({ id: agentTurn.id })
                      .from(agentTurn)
                      .where(and(eq(agentTurn.id, turnID), eq(agentTurn.state, "failed"))),
                  ),
                ),
              );
            return;
          }
          if (outcome.state === "succeeded") {
            if (!(await confirmSettledOpenCodeInput(client, session.sessionID, intent.promptID)))
              throw new Error(
                "OpenCode reported a final answer but its execution tree or queued input is not settled",
              );
            // Shutdown can start during the final native settlement reads.
            // Join that observation without publishing its late result.
            if (closed) return;
            await usageJournal.settle(turnID, "completed");
            const reviewTurn = await turns.get(turnID);
            if (reviewTurn?.authority.mode === "build" && reviewTurn.authority.review) {
              await browser?.finishTurnRecording(turnID, ownerToken, observationController.signal);
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
              notifyActivity(changeID);
              run(archives.savePending());
              return;
            }
            const settled = await turns.settle(
              turnID,
              ownerToken,
              "completed",
              outcome.summary
                ? bounded(`Agent reports completion: ${outcome.summary}`, 2_000)
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
              throw new CommandError(
                "conflict",
                "Build outcome no longer owns its current authority",
              );
            notifyActivity(changeID);
            run(archives.savePending());
            await candidates.reconcile(turnID);
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
        if (!closed) await Bun.sleep(100);
      }
    } finally {
      detach?.();
      wake.dispose();
      await browser?.closeTurn(turnID);
      monitors.delete(turnID);
      notifyActivity(changeID);
    }
  }

  const stopping = new Set<string>();
  const readyStops = new Set<string>();
  async function reconcileStop(changeID: string, runtimeReady = false, expectedStopID?: string) {
    if (closed) return;
    const target = await row(changeID);
    if (
      closed ||
      !target?.stopPending ||
      !target.stopID ||
      (expectedStopID && target.stopID !== expectedStopID)
    )
      return;
    if (stopping.has(target.stopID)) {
      // Readiness can arrive while the final old observation still sees a
      // disconnected runtime. Coalesce one follow-up instead of losing it.
      if (runtimeReady) readyStops.add(target.stopID);
      return;
    }
    stopping.add(target.stopID);
    try {
      for (let observation = 0; observation < 5 && !closed; observation += 1) {
        const session = observation === 0 ? target : await row(changeID);
        if (!session?.stopPending || session.stopID !== target.stopID) return;
        try {
          if (await stop.confirm(changeID, target.stopID)) return;
        } catch {
          /* Keep admission blocked until persisted Stop is confirmed. */
        }
        if (observation < 4 && !closed) await Bun.sleep(1_000);
      }
      if (!closed)
        await stop.recordUnconfirmed(changeID, {
          stopID: target.stopID,
          attemptID: target.runtimeAttemptID,
          sessionID: target.sessionID,
        });
    } finally {
      stopping.delete(target.stopID);
      const becameReady = readyStops.delete(target.stopID);
      if (becameReady && !closed) run(reconcileStop(changeID, false, target.stopID));
    }
  }

  return {
    // Stop observing and join owned work before its database/transport is
    // disposed. Durable intent remains recoverable; this does not issue Stop.
    async shutdown() {
      closed = true;
      observationController.abort();
      await nativeEvents.shutdown();
      while (background.size) await Promise.allSettled([...background]);
      await browser?.recover();
    },
    subscribeActivity(changeID: string, notify: () => void) {
      if (closed) return () => {};
      const listeners = activityListeners.get(changeID) ?? new Set();
      const listener: {
        notify(): void;
        attemptID?: string;
        detach?: () => void;
      } = { notify };
      listeners.add(listener);
      activityListeners.set(changeID, listeners);
      return () => {
        listener.detach?.();
        listeners.delete(listener);
        if (!listeners.size) activityListeners.delete(changeID);
      };
    },
    runtimeActivityChanged() {
      notifyActivity();
    },
    async recover() {
      if (closed) return;
      run(archives.savePending());
      // Failure settlement and its Session projection can lose their connection
      // independently. Restore only the exact failed Turn's diagnostic state;
      // this neither executes work nor resolves uncertain external outcomes.
      await database.db
        .update(changeAgentSession)
        .set({
          state: "failed",
          lastError: agentTurn.outcomeSummary,
          updatedAt: expression`now()`,
        })
        .from(agentTurn)
        .where(
          and(
            eq(changeAgentSession.activeTurnId, agentTurn.id),
            eq(agentTurn.state, "failed"),
            inArray(changeAgentSession.state, ["starting", "working"]),
            not(changeAgentSession.stopPending),
            eq(agentTurn.changeId, changeAgentSession.changeId),
            exists(
              database.db
                .select({ id: changeAgentTurnIntent.turnId })
                .from(changeAgentTurnIntent)
                .innerJoin(changeTable, eq(changeTable.id, changeAgentTurnIntent.changeId))
                .where(
                  and(
                    eq(changeTable.id, changeAgentSession.changeId),
                    inArray(changeTable.state, ["starting", "active"]),
                    eq(changeAgentTurnIntent.turnId, agentTurn.id),
                    eq(changeAgentTurnIntent.changeId, changeAgentSession.changeId),
                    eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
                    eq(changeAgentTurnIntent.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
                    eq(changeTable.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
                    or(
                      and(
                        eq(changeAgentSession.state, "starting"),
                        isNull(changeAgentSession.activeInboxId),
                      ),
                      and(
                        eq(changeAgentSession.state, "working"),
                        eq(changeAgentSession.activeInboxId, changeAgentTurnIntent.promptId),
                      ),
                    ),
                  ),
                ),
            ),
          ),
        );
      for (const operation of await candidates.pending())
        run(candidates.reconcile(operation.id, true));
      const external = await database.db
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .where(
          and(
            isNotNull(agentTurn.changeId),
            inArray(agentTurn.state, ["dispatching", "running", "uncertain"]),
          ),
        )
        .orderBy(asc(agentTurn.createdAt));
      for (const turn of external) run(recoverExternal(turn.id));
      const pending = await database.db
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .where(and(isNotNull(agentTurn.changeId), eq(agentTurn.state, "pending")))
        .orderBy(asc(agentTurn.createdAt));
      for (const turn of pending) run(execute(turn.id));
      const stopped = await database.db
        .select({ changeID: changeAgentSession.changeId })
        .from(changeAgentSession)
        .where(eq(changeAgentSession.stopPending, true));
      for (const session of stopped) run(reconcileStop(session.changeID));
    },

    // Startup runs before the Connector listener exists. Readiness resumes
    // recorded commits and Stop only, never an inference request or new runtime.
    recoverRuntimeWork(attemptID: string) {
      run(archives.savePending());
      const work = Promise.all([
        candidates.recoverRuntime(attemptID),
        (async () => {
          const stopped = await database.db
            .select({ changeID: changeAgentSession.changeId })
            .from(changeAgentSession)
            .where(
              and(
                eq(changeAgentSession.runtimeAttemptId, attemptID),
                eq(changeAgentSession.stopPending, true),
              ),
            );
          await Promise.all(stopped.map((session) => reconcileStop(session.changeID, true)));
        })(),
      ]).then(() => {});
      run(work);
      return work;
    },

    async dispatchRuntimePending(attemptID: string) {
      const pending = await database.db
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
        .where(
          and(
            eq(changeAgentTurnIntent.runtimeAttemptId, attemptID),
            eq(agentTurn.state, "pending"),
          ),
        );
      for (const turn of pending) run(execute(turn.id));
    },

    async recoverRetainedStops() {
      if (closed || (!settleRetainedStop && !runtime.get)) return;
      const stopped = await database.client<{ changeID: string }[]>`
        SELECT session.change_id AS "changeID" FROM factory.change_agent_session session
        JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
        WHERE session.stop_pending AND (attempt.state IN ('failed','cleanup-failed','stopped')
          OR (${Boolean(settleRetainedStop)} AND attempt.state IN ('paused','starting','pausing'))
          OR (${Boolean(runtime.get)} AND attempt.state='paused'
            AND session.native_session_confirmed_at IS NULL
            AND session.implementation_session_confirmed_at IS NULL
            AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
              WHERE intent.turn_id=session.stop_turn_id AND intent.bootstrap
                AND intent.session_id=session.opencode_session_id
                AND intent.runtime_attempt_id=attempt.id)))`;
      for (const session of stopped) run(reconcileStop(session.changeID));
    },

    async dispatchReadyPending() {
      run(archives.savePending());
      const pending = await database.client<
        Array<{ id: string }>
      >`SELECT turn.id FROM factory.agent_turn turn
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
        WHERE turn.state='pending' AND (
          attempt.state='ready'
          OR (intent.runtime_attempt_id IS NULL AND EXISTS(
            SELECT 1 FROM factory.change_writer writer
            JOIN factory.change change ON change.id=writer.change_id
            JOIN factory.runtime_attempt prepared ON prepared.id=change.runtime_attempt_id
              AND prepared.change_id=change.id AND prepared.project_id=change.project_id
            WHERE writer.change_id=turn.change_id AND writer.turn_id=turn.id
              AND writer.state='agent' AND NOT writer.fence_required AND prepared.state='ready'
          ))
          OR (intent.runtime_attempt_id IS NULL AND EXISTS(
            SELECT 1 FROM factory.change_writer writer
            JOIN factory.runtime_attempt previous ON previous.id=writer.fence_attempt_id
            WHERE writer.change_id=turn.change_id AND writer.turn_id=turn.id
              AND writer.state='agent-preparing' AND writer.fence_required
              AND (previous.state='stopped' OR (previous.state='paused'))
          )))
          AND (turn.owner_token IS NULL OR turn.owner_expires_at<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM factory.coding_pause WHERE turn_id=turn.id AND resumed_by_turn_id IS NULL)
        ORDER BY turn.created_at LIMIT 16`;
      for (const turn of pending) run(execute(turn.id));
    },

    async start(
      changeID: string,
      userID: string,
      commandId: string,
      codingReasoning?: CodingReasoning,
      contextID?: string,
    ) {
      if (closed) throw new Error("Agent controller is closed");
      const accepted = await admission.admit(changeID, userID, {
        kind: "change-start",
        commandId,
        ...(codingReasoning ? { codingReasoning } : {}),
        ...(contextID ? { contextId: contextID } : {}),
      });
      if (!accepted.replayed) run(execute(accepted.turn.id));
      return this.get(changeID, accepted.turn.id);
    },
    async resume(changeID: string, userID: string, commandID: string, pausedTurnID: string) {
      const [pendingResume] = await database.db
        .select({
          state: agentTurn.state,
          review: expression<boolean>`${agentTurn.authority} ? 'review'`,
          attemptID: changeAgentTurnIntent.runtimeAttemptId,
          sessionID: changeAgentTurnIntent.sessionId,
          promptID: changeAgentTurnIntent.promptId,
        })
        .from(agentTurn)
        .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
        .innerJoin(codingPause, eq(codingPause.turnId, agentTurn.id))
        .where(
          and(
            eq(agentTurn.id, pausedTurnID),
            eq(agentTurn.changeId, changeID),
            isNull(codingPause.resumedByTurnId),
          ),
        );
      const [project] = await database.db
        .select({ id: changeTable.projectId })
        .from(changeTable)
        .where(eq(changeTable.id, changeID));
      if (!project) throw new CommandError("not-found", "Change not found");
      await database.client.begin((sql) => projectAuthorityIn(sql, userID, project.id));
      if (pendingResume?.state === "failed" && pendingResume.review)
        throw new CommandError(
          "conflict",
          "Retry the independent review after resolving its Coding allowance. A review cannot resume as implementation.",
        );
      if (
        pendingResume?.state === "failed" &&
        (!pendingResume.attemptID ||
          !(await confirmSettledOpenCodeInput(
            opencode(hub, pendingResume.attemptID),
            pendingResume.sessionID,
            pendingResume.promptID,
          )))
      )
        throw new CommandError(
          "conflict",
          "Wait for the previous model call and queued input to finish before resuming",
        );
      const turnID = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`coding-resume:${commandID}`}))`;
        const input = { changeID, pausedTurnID };
        const db = drizzleTransaction(sql);
        const [old] = await db
          .select({
            actorID: executionPolicyCommand.actorId,
            input: expression<{
              changeID: string;
              pausedTurnID: string;
            }>`${executionPolicyCommand.input}`,
            result: expression<{ turnID: string }>`${executionPolicyCommand.result}`,
          })
          .from(executionPolicyCommand)
          .where(eq(executionPolicyCommand.commandId, commandID));
        const [project] = await db
          .select({ id: changeTable.projectId })
          .from(changeTable)
          .where(eq(changeTable.id, changeID));
        if (!project) throw new CommandError("not-found", "Change not found");
        if (old) {
          await projectAuthorityIn(sql, userID, project.id);
          if (
            old.actorID !== userID ||
            old.input.changeID !== changeID ||
            old.input.pausedTurnID !== pausedTurnID
          )
            throw new CommandError("conflict", "Resume command changed input");
          return old.result.turnID;
        }
        await db
          .select({ id: agentTurn.id })
          .from(agentTurn)
          .where(eq(agentTurn.id, pausedTurnID))
          .for("update");
        await lockChangeWriterIn(sql, changeID);
        await projectAuthorityIn(sql, userID, project.id);
        const [paused] = await db
          .select({ state: agentTurn.state })
          .from(codingPause)
          .innerJoin(agentTurn, eq(agentTurn.id, codingPause.turnId))
          .where(
            and(
              eq(codingPause.turnId, pausedTurnID),
              eq(agentTurn.changeId, changeID),
              isNull(codingPause.resumedByTurnId),
            ),
          )
          .for("update");
        if (!paused) throw new CommandError("conflict", "This Coding pause is no longer current");
        let next: string;
        if (paused.state === "pending") next = await turns.resumePendingIn(sql, pausedTurnID);
        else if (paused.state === "failed") {
          const accepted = await admission.admitIn(sql, changeID, userID, {
            kind: "change-prompt",
            commandId: commandID,
            resume: true,
            text: "Continue the already commissioned implementation from the retained checkout. Factory paused the previous turn at its Coding allowance. Preserve existing changes, complete the remaining work and run the repository checks. Do not commit or push; Factory handles that after successful completion.",
          });
          next = accepted.turn.id;
        } else
          throw new CommandError(
            "conflict",
            "Wait for the current model call to finish before resuming",
          );
        await db.insert(executionPolicyCommand).values({
          commandId: commandID,
          scope: `coding-resume:${changeID}`,
          actorId: userID,
          input,
          result: { turnID: next },
        });
        return next;
      });
      run(execute(turnID));
      return this.get(changeID, turnID);
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
      for (const turn of pending) run(execute(turn.id));
    },

    async prompt(
      changeID: string,
      text: string,
      userID: string,
      commandId: string,
      repair = false,
      contextID?: string,
    ) {
      if (closed) throw new Error("Agent controller is closed");
      const accepted = await admission.admit(changeID, userID, {
        kind: repair ? "change-repair" : "change-prompt",
        commandId,
        text,
        ...(contextID ? { contextId: contextID } : {}),
      });
      if (!accepted.replayed) run(execute(accepted.turn.id));
      return this.get(changeID, accepted.turn.id);
    },

    async admitPromptIn(
      sql: DatabaseTransaction,
      changeID: string,
      userID: string,
      text: string,
      commandId: string,
    ) {
      if (closed) throw new Error("Agent controller is closed");
      const accepted = await admission.admitIn(sql, changeID, userID, {
        kind: "change-prompt",
        commandId,
        text,
      });
      return accepted.turn.id;
    },

    async review(changeID: string, reviewID: string, userID: string) {
      if (closed) throw new Error("Agent controller is closed");
      const accepted = await admitReview(changeID, reviewID, userID);
      if (!accepted.replayed) run(execute(accepted.turn.id));
      return this.get(changeID, accepted.turn.id);
    },

    async stop(changeID: string, handoff?: PendingWriterHandoff) {
      await stop.persist(changeID, handoff);
      notifyActivity(changeID);
      await browser?.closeChange(changeID);
      try {
        if (!(await stop.confirm(changeID))) run(reconcileStop(changeID));
      } catch {
        run(reconcileStop(changeID));
      }
      return this.get(changeID);
    },

    async recheckStop(changeID: string, stopID: string) {
      if (closed) throw new Error("Agent controller is closed");
      const target = await row(changeID);
      if (!target?.stopPending) return this.get(changeID);
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
      return this.get(changeID);
    },

    async retainedMessages(conversationID: string, contextID?: string) {
      const original = alias(runtimeAttempt, "original");
      const current = alias(runtimeAttempt, "current");
      const [context] = await database.db
        .select({
          changeID: changeTable.id,
          id: conversationContext.id,
          original: conversationContext.original,
          nativeID: conversationContext.nativeSessionId,
          currentID: expression<
            string | null
          >`${conversationContext.archivedSession}->>'opencode_session_id'`,
          confirmed: expression<boolean>`${conversationContext.archivedSession}->>'native_session_confirmed_at' IS NOT NULL OR
          ${conversationContext.archivedSession}->>'implementation_session_confirmed_at' IS NOT NULL`,
          attemptID: current.id,
        })
        .from(conversationContext)
        .innerJoin(changeTable, eq(changeTable.id, conversationContext.changeId))
        .leftJoin(
          original,
          expression`${original.id}=(${conversationContext.archivedSession}->>'runtime_attempt_id')::uuid`,
        )
        .leftJoin(
          current,
          and(
            eq(current.id, changeTable.runtimeAttemptId),
            eq(current.state, "ready"),
            eq(current.workspaceId, original.workspaceId),
            isNotNull(current.workspaceId),
          ),
        )
        .where(
          and(
            eq(conversationContext.conversationId, conversationID),
            isNotNull(conversationContext.archivedSession),
            contextID === undefined
              ? eq(conversationContext.original, true)
              : eq(conversationContext.id, contextID),
          ),
        )
        .limit(1);
      if (!context) return;
      if (!context.confirmed) return { messages: [], messagesAvailable: true };
      if (!context.attemptID || !hub.connected(context.attemptID))
        return archives.retainedMessages(context.id).catch(() => undefined);
      const intents = await database.db
        .select({
          promptID: changeAgentTurnIntent.promptId,
          text: expression<
            string | null
          >`CASE WHEN ${agentTurn.input}->>'kind'='change-start' THEN NULL ELSE ${agentTurn.input}->>'text' END`,
        })
        .from(changeAgentTurnIntent)
        .innerJoin(agentTurn, eq(agentTurn.id, changeAgentTurnIntent.turnId))
        .where(
          and(
            eq(changeAgentTurnIntent.changeId, context.changeID),
            expression`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM ${context.original ? null : context.id}::text`,
          ),
        );
      try {
        const client = opencode(hub, context.attemptID);
        const messages = (
          await Promise.all(
            [
              ...new Set(
                [context.nativeID, context.currentID].filter((id): id is string => Boolean(id)),
              ),
            ].map((sessionID) =>
              client.message
                .list({ sessionID, limit: 100 }, { signal: AbortSignal.timeout(2_000) })
                .then((page) =>
                  projectMessages(
                    page,
                    new Map(intents.map((intent) => [intent.promptID, intent.text])),
                  ),
                ),
            ),
          )
        ).flat();
        return {
          messages: [...new Map(messages.map((message) => [message.id, message])).values()].sort(
            (a, b) => a.at - b.at,
          ),
          messagesAvailable: true,
        };
      } catch {
        return archives.retainedMessages(context.id).catch(() => undefined);
      }
    },
    async newConversation(
      changeID: string,
      userID: string,
      commandID: string,
      expectedContextID: string | null,
    ) {
      await database.client.begin(async (sql) => {
        const [change] = await drizzleTransaction(sql)
          .select({ projectID: changeTable.projectId })
          .from(changeTable)
          .where(eq(changeTable.id, changeID));
        if (!change) throw new CommandError("not-found", "Change not found");
        await projectDevelopmentAuthorityIn(sql, userID, change.projectID);
      });
      const snapshot = await this.get(changeID, undefined, true, true);
      return createCodingContexts(database)(changeID, userID, commandID, expectedContextID, {
        messages: snapshot.messages,
        admittedMessages: snapshot.admittedMessages ?? [],
        messagesAvailable: snapshot.messagesAvailable,
        turn: snapshot.turn ?? null,
      });
    },
    async get(changeID: string, turnID?: string, history = true, includeNavigation = true) {
      const transcriptArchive = await archives.status(changeID);
      const [waiting] = await database.db
        .select({ reason: runtimeComputeWait.reason })
        .from(runtimeComputeWait)
        .innerJoin(changeTable, eq(changeTable.runtimeAttemptId, runtimeComputeWait.attemptId))
        .where(eq(changeTable.id, changeID));
      const turn = await readTurnObservation(database, { changeID, ...(turnID ? { turnID } : {}) });
      const intents = history
        ? await database.db
            .select({
              turnID: changeAgentTurnIntent.turnId,
              commandID: agentTurn.commandId,
              sessionID: changeAgentTurnIntent.sessionId,
              promptID: changeAgentTurnIntent.promptId,
              bootstrap: expression<boolean>`${agentTurn.input}->>'kind'='change-start'`,
              text: expression<string | null>`${agentTurn.input}->>'text'`,
              at: expression<number>`EXTRACT(EPOCH FROM ${agentTurn.createdAt})::float8 * 1000`,
            })
            .from(changeAgentTurnIntent)
            .innerJoin(agentTurn, eq(agentTurn.id, changeAgentTurnIntent.turnId))
            .where(
              and(
                eq(changeAgentTurnIntent.changeId, changeID),
                expression`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM (${database.db
                  .select({
                    contextID: expression<
                      string | null
                    >`${ticketConversation.activeCodingContextId}::text`,
                  })
                  .from(ticketConversation)
                  .innerJoin(changeTable, eq(changeTable.ticketId, ticketConversation.ticketId))
                  .where(eq(changeTable.id, changeID))})`,
              ),
            )
            .orderBy(desc(changeAgentTurnIntent.createdAt), desc(changeAgentTurnIntent.turnId))
            .limit(100)
        : [];
      const admittedMessages = intents.toReversed().flatMap((intent) =>
        !intent.bootstrap && intent.text !== null
          ? [
              {
                id: intent.promptID,
                commandId: intent.commandID,
                role: "user" as const,
                text: bounded(intent.text, 8_000),
                at: intent.at,
              },
            ]
          : [],
      );
      const [pause] = await database.db
        .select({ reason: codingPause.reason, turnID: codingPause.turnId })
        .from(codingPause)
        .innerJoin(agentTurn, eq(agentTurn.id, codingPause.turnId))
        .where(
          and(
            eq(agentTurn.changeId, changeID),
            isNull(codingPause.resumedByTurnId),
            inArray(agentTurn.state, ["pending", "dispatching", "running", "failed"]),
            notExists(
              database.db
                .select({ id: changeAgentSession.changeId })
                .from(changeAgentSession)
                .where(
                  and(
                    eq(changeAgentSession.changeId, changeID),
                    or(
                      eq(changeAgentSession.stopPending, true),
                      eq(changeAgentSession.state, "stopped"),
                    ),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(codingPause.createdAt))
        .limit(1);
      // Git settlement updates the operation and Session together. Capture them
      // in one read snapshot so native history latency cannot split that outcome.
      // Release the pooled connection before any native transcript request.
      const { session, operations, pendingCommits, emptyCommit } = await database.client.begin(
        "isolation level repeatable read read only",
        async (sql) => {
          const session = await row(changeID, sql);
          const db = drizzleTransaction(sql);
          const operations = await db
            .select({ commitSHA: changeCommitOperation.commitSha })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, changeID),
                eq(changeCommitOperation.state, "succeeded"),
              ),
            )
            .orderBy(desc(changeCommitOperation.sequence))
            .limit(1);
          const pendingCommits = await db
            .select({
              id: changeCommitOperation.id,
              state: expression<
                "commit-intended" | "committed" | "push-intended"
              >`${changeCommitOperation.state}`,
              lastError: changeCommitOperation.lastError,
            })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, changeID),
                eq(changeCommitOperation.source, "agent"),
                inArray(changeCommitOperation.state, [
                  "commit-intended",
                  "committed",
                  "push-intended",
                ]),
              ),
            )
            .limit(1);
          const [emptyCommit] =
            turn?.state === "completed"
              ? await db
                  .select({ summary: expression<string>`${changeCommitOperation.lastError}` })
                  .from(changeCommitOperation)
                  .where(
                    and(
                      eq(changeCommitOperation.id, turn.id),
                      eq(changeCommitOperation.changeId, changeID),
                      eq(changeCommitOperation.state, "failed"),
                      isNull(changeCommitOperation.commitSha),
                      inArray(changeCommitOperation.lastError, [
                        noChangesToSubmit,
                        noChangesToSubmit + earlierSubmissionUnchanged,
                      ]),
                    ),
                  )
              : [];
          return { session, operations, pendingCommits, emptyCommit };
        },
      );
      // Project only this exact Turn's empty commit, never a newer candidate's
      // diagnostic onto historical turns or back into immutable turn history.
      if (turn && emptyCommit) turn.summary = emptyCommit.summary;
      if (!session) {
        bindActivity(changeID);
        return {
          state:
            turn?.state === "stopped"
              ? "stopped"
              : turn?.state === "failed" || turn?.state === "uncertain"
                ? "failed"
                : turn
                  ? "starting"
                  : "idle",
          turn,
          lastError: turn?.summary ?? null,
          commitOperation: undefined,
          messages: [],
          ...(admittedMessages.length ? { admittedMessages } : {}),
          messagesAvailable: true,
          sessionAvailable: false,
          runtimeConnected: false,
          stopPending: false,
          stopId: null,
          codingPause: pause ?? null,
          computeWait: waiting?.reason ?? null,
          transcriptArchive,
        };
      }
      let messages: ReturnType<typeof projectMessages> = [];
      let messagesAvailable = false;
      let activityAttemptID = session.runtimeAttemptID;
      let activityRuntimeState = session.runtimeState;
      let displayRuntimeState = session.runtimeState;
      if (session.sessionID && ["failed", "stopped"].includes(session.runtimeState)) {
        const current = alias(runtimeAttempt, "current");
        const original = alias(runtimeAttempt, "original");
        const [retained] = await database.db
          .select({ id: current.id, state: current.state })
          .from(changeTable)
          .innerJoin(current, eq(current.id, changeTable.runtimeAttemptId))
          .innerJoin(original, eq(original.id, session.runtimeAttemptID))
          .where(
            and(
              eq(changeTable.id, changeID),
              inArray(changeTable.state, ["starting", "active"]),
              eq(current.changeId, changeTable.id),
              eq(original.changeId, changeTable.id),
              eq(current.workspaceId, original.workspaceId),
              isNotNull(current.workspaceId),
              gt(current.generation, original.generation),
            ),
          );
        if (retained) {
          displayRuntimeState = retained.state;
          // Saved lifecycle state is displayable before retained OpenCode history is reachable.
          if (retained.state === "ready") {
            activityAttemptID = retained.id;
            activityRuntimeState = retained.state;
          }
        }
      }
      if (session.sessionConfirmed && session.sessionID && activityRuntimeState === "ready")
        bindActivity(changeID, activityAttemptID);
      else bindActivity(changeID);
      if (
        history &&
        session.sessionConfirmed &&
        session.sessionID &&
        activityRuntimeState === "ready"
      ) {
        try {
          const client = opencode(hub, activityAttemptID);
          const page = await client.message.list(
            { sessionID: session.sessionID, limit: 100 },
            { signal: AbortSignal.timeout(2_000) },
          );
          const sessionIntents = intents.filter((intent) => intent.sessionID === session.sessionID);
          messages = projectMessages(
            page,
            new Map(
              sessionIntents.map((intent) => [
                intent.promptID,
                intent.bootstrap ? null : intent.text,
              ]),
            ),
          );
          if (
            session.implementationSessionConfirmed &&
            session.implementationSessionID &&
            session.implementationSessionID !== session.sessionID
          ) {
            const implementationPage = await client.message
              .list(
                { sessionID: session.implementationSessionID, limit: 100 },
                { signal: AbortSignal.timeout(2_000) },
              )
              .catch(() => null);
            if (implementationPage)
              messages = [
                ...projectMessages(
                  implementationPage,
                  new Map(
                    intents
                      .filter((intent) => intent.sessionID === session.implementationSessionID)
                      .map((intent) => [intent.promptID, intent.bootstrap ? null : intent.text]),
                  ),
                ),
                ...messages,
              ].sort((a, b) => a.at - b.at);
          }
          if (turn) {
            const intent = sessionIntents.find((intent) => intent.turnID === turn.id);
            if (intent) turn.usage = observeOpenCodeUsage(page.data, intent.promptID);
          }
          messagesAvailable = true;
        } catch {
          // Unavailable live activity must not block persisted completion or Stop state.
        }
      }
      const failed = turn?.state === "uncertain" || turn?.state === "failed";
      const preparingNewTurn = Boolean(
        turn &&
          turn.id !== session.activeTurnID &&
          (turn.state === "pending" || turn.state === "dispatching"),
      );
      return {
        codingPause: pause ?? null,
        computeWait: waiting?.reason ?? null,
        transcriptArchive,
        state: preparingNewTurn
          ? "starting"
          : session.state === "stopped"
            ? "stopped"
            : failed
              ? "failed"
              : turn?.state === "pending" || turn?.state === "dispatching"
                ? "starting"
                : session.state,
        turn,
        runtimeState: displayRuntimeState,
        lastError:
          turn?.state === "uncertain"
            ? `Execution outcome uncertain. Stop or resolve this turn before new Build work. ${turn.summary ?? ""}`
            : failed
              ? (turn?.summary ?? session.lastError)
              : preparingNewTurn
                ? null
                : session.lastError,
        commitSHA: operations[0]?.commitSHA ?? null,
        ...(pendingCommits[0] ? { commitOperation: pendingCommits[0] } : {}),
        messages: navigationMessages(messages, includeNavigation),
        ...(admittedMessages.length ? { admittedMessages } : {}),
        messagesAvailable,
        sessionAvailable: Boolean(
          session.implementationSessionID && session.implementationSessionConfirmed,
        ),
        runtimeConnected: hub.connected(activityAttemptID),
        stopPending: !preparingNewTurn && session.stopPending,
        stopId: !preparingNewTurn && session.stopPending ? session.stopID : null,
      };
    },
  };
}
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  notExists,
  or,
  sql as expression,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
