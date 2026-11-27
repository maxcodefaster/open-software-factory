import {
  and,
  desc,
  eq,
  sql as expression,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentSession,
  changeAgentTurnIntent,
  changeCommitOperation,
  change as changeTable,
  conversationContext,
  operation,
  runtimeAttempt,
  ticketConversation,
} from "#db/schema";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import { earlierSubmissionUnchanged, noChangesToSubmit } from "./candidate";
import {
  type AgentActivity,
  type AgentSessionArchives,
  type Database,
  opencode,
  readAgentRow,
} from "./controller-types";
import { createCodingContexts } from "./conversation-contexts";
import { navigationMessages, projectMessages } from "./message-projection";
import { bounded } from "./native-errors";
import { readOpenCodeWorkspace } from "./opencode-adapter";
import { observeOpenCodeUsage } from "./opencode-usage";
import { readTurnObservation } from "./turn-observation";

const ZOD_FAILURE_REPLACEMENT =
  "Factory encountered an unexpected validation response from the runtime or cluster. Check the installation status before retrying.";

function sanitizeFailureMessage(message: string | null | undefined): string | null {
  if (!message) return message ?? null;
  const trimmed = message.trim();
  const start = trimmed.indexOf("[{");
  if (start === -1 || !trimmed.endsWith("]")) return message;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start));
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (issue) =>
          issue &&
          typeof issue === "object" &&
          "code" in issue &&
          "path" in issue &&
          "message" in issue,
      )
    ) {
      const prefix = trimmed.slice(0, start).trim();
      return prefix ? `${prefix} ${ZOD_FAILURE_REPLACEMENT}` : ZOD_FAILURE_REPLACEMENT;
    }
  } catch {
    // Not a serialized ZodError array; preserve original message.
  }
  return message;
}

export type AgentViewsDeps = {
  database: Database;
  hub: RuntimeHub;
  archives: AgentSessionArchives;
  activity: AgentActivity;
};

export function createAgentViews(deps: AgentViewsDeps) {
  const { database, hub, archives, activity } = deps;

  async function retainedMessages(conversationID: string, contextID?: string) {
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
  }

  async function get(changeID: string, turnID?: string, history = true, includeNavigation = true) {
    const transcriptArchive = await archives.status(changeID);
    const [waiting] = await database.db
      .select({
        reason: expression<
          | "compute-capacity"
          | "accounting-incomplete"
          | "coding-budget-used"
          | "finish-reserve-used"
          | null
        >`${operation.payload}->>'reason'`,
      })
      .from(operation)
      .innerJoin(
        changeTable,
        and(
          eq(operation.kind, "runtime.compute_wait"),
          eq(operation.scopeType, "runtime_attempt"),
          eq(operation.scopeId, expression`${changeTable.runtimeAttemptId}::text`),
          eq(
            operation.idempotencyKey,
            expression`'runtime.compute_wait:' || ${changeTable.runtimeAttemptId}::text`,
          ),
        ),
      )
      .where(eq(changeTable.id, changeID));
    const turn = await readTurnObservation(database, { changeID, ...(turnID ? { turnID } : {}) });
    // Retain the native refusal as retry evidence, not an automatic-wait
    // promise for an already settled Turn.
    const computeWait =
      turn?.state === "pending" || turn?.state === "dispatching" ? (waiting?.reason ?? null) : null;
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
      .select({
        reason: expression<string>`${operation.payload}->>'reason'`,
        turnID: expression<string>`(${operation.scopeId})::uuid`,
      })
      .from(operation)
      .innerJoin(agentTurn, eq(expression`${agentTurn.id}::text`, operation.scopeId))
      .where(
        and(
          eq(operation.kind, "usage.coding_pause"),
          eq(operation.scopeType, "agent_turn"),
          eq(operation.state, "paused"),
          expression`(${operation.payload}->>'resumedByTurnId') IS NULL`,
          eq(agentTurn.changeId, changeID),
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
      .orderBy(desc(operation.createdAt))
      .limit(1);
    // Git settlement updates the operation and Session together. Capture them
    // in one read snapshot so native history latency cannot split that outcome.
    // Release the pooled connection before any native transcript request.
    const { session, operations, pendingCommits, emptyCommit } = await database.client.begin(
      "isolation level repeatable read read only",
      async (sql) => {
        const session = await readAgentRow(database, changeID, sql);
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
      activity.bindActivity(changeID);
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
        lastError: sanitizeFailureMessage(turn?.summary),
        commitOperation: undefined,
        messages: [],
        ...(admittedMessages.length ? { admittedMessages } : {}),
        messagesAvailable: true,
        sessionAvailable: false,
        runtimeConnected: false,
        stopPending: false,
        stopId: null,
        codingPause: pause ?? null,
        computeWait,
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
      activity.bindActivity(changeID, activityAttemptID);
    else activity.bindActivity(changeID);
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
        const checkoutDirectory = includeNavigation
          ? await readOpenCodeWorkspace(client)
              .then((workspace) => workspace.checkoutDirectory)
              .catch(() => undefined)
          : undefined;
        const sessionIntents = intents.filter((intent) => intent.sessionID === session.sessionID);
        messages = projectMessages(
          page,
          new Map(
            sessionIntents.map((intent) => [
              intent.promptID,
              intent.bootstrap ? null : intent.text,
            ]),
          ),
          checkoutDirectory,
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
                checkoutDirectory,
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
    if (
      history &&
      !messagesAvailable &&
      turn?.state === "completed" &&
      turn.id === session.activeTurnID &&
      session.sessionConfirmed &&
      session.sessionID
    ) {
      const retained = await archives
        .retainedMessages({
          changeID,
          turnID: turn.id,
          runtimeAttemptID: session.runtimeAttemptID,
          sessionID: session.sessionID,
        })
        .catch(() => undefined);
      if (retained) {
        messages = retained.messages;
        messagesAvailable = retained.messagesAvailable;
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
      computeWait,
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
      lastError: sanitizeFailureMessage(
        turn?.state === "uncertain"
          ? `Execution outcome uncertain. Stop or resolve this turn before new Build work. ${turn.summary ?? ""}`
          : failed
            ? (turn?.summary ?? session.lastError)
            : preparingNewTurn
              ? null
              : session.lastError,
      ),
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
  }

  async function newConversation(
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
    const snapshot = await get(changeID, undefined, true, true);
    return createCodingContexts(database)(changeID, userID, commandID, expectedContextID, {
      messages: snapshot.messages,
      admittedMessages: snapshot.admittedMessages ?? [],
      messagesAvailable: snapshot.messagesAvailable,
      turn: snapshot.turn ?? null,
    });
  }

  return {
    retainedMessages,
    newConversation,
    get,
  };
}
