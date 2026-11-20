import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql as query } from "drizzle-orm";
import { z } from "zod";
import {
  type BuildBrowserCall,
  type BuildBrowserResult,
  buildBrowserCallInput,
  buildBrowserResultInput,
} from "../../../../packages/conversation-domain/src/browser-tools";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  buildBrowserSession,
  candidateReview,
  changeAgentTurnIntent,
  reviewMedia,
  runtimeAttempt,
  substrateBinding,
} from "../../../../packages/db/src/schema";
import { runtimeBuildBrowserToken } from "../../../../packages/runtime-domain/src/identity";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { createReviewMedia, maximumRecordingBytes } from "../review/media";
import { substrateFactoryURL } from "../runtime/endpoints";
import { type RuntimeHub, RuntimeParentOperationError } from "../runtime/hub";
import { createAgentTurnStore } from "./turn-store";

type BrowserSession = {
  id: string;
  ordinal: number;
  turnID: string;
  changeID: string;
  attemptID: string;
  generation: number;
  agentSessionID: string;
  ownerID: string;
  state: "intended" | "active" | "closing" | "closed";
};

function ownerIdentity(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function browserIdentity(turnID: string, ownerID: string, ordinal = 1) {
  const key = `factory-browser-v1:${turnID}:${ownerID}${ordinal > 1 ? `:${ordinal}` : ""}`;
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function browserPreparing(cause: unknown) {
  return (
    cause instanceof RuntimeParentOperationError &&
    cause.action === "browser-call" &&
    cause.message ===
      "Browser tools are preparing; retry browser inspection after preparation completes"
  );
}

// Exact static Connector failures only. Never forward arbitrary runtime,
// registry, parser or tool output as a user-facing diagnostic.
const safeBrowserFailures = new Set([
  "browser App is not declared in this Workspace",
  "browser operation does not match its admitted execution scope",
  "browser execution lease is expired or exceeds its bound",
  "browser control connection ended",
  "browser session does not belong to the active execution owner",
  "browser session requires owned cleanup after parent restart; do not replay a UI mutation",
  "browser session already ended; open a fresh browser session",
  "browser session is no longer active",
  "browser renewal does not own this execution",
  "Browser no longer owns this Build execution",
  "Browser execution authority is expiring",
  "Browser requires live Build authority",
  "Browser Build authority changed before dispatch",
  "Browser returned an invalid observation schema",
  "browser container operation was not confirmed",
  "browser primary container inspection was not confirmed",
  "browser primary container no longer owns this Workspace generation",
  "browser container did not retain its exact isolation boundary",
  "browser create outcome could not be recovered by its persisted identity",
  "browser socket/configuration directory unavailable",
  "browser socket directory ownership unavailable",
  "browser App proxy startup exceeded its authority",
  "browser App proxy did not become ready within five seconds",
  "browser tool process failed to start",
  "browser tool outcome is unavailable; do not repeat a UI mutation without checking the App",
  "browser tool exceeded its execution authority or deadline",
  "browser execution authority ended",
  "browser MCP did not report the pinned upstream version",
  "browser MCP initialization was not confirmed",
  "browser App page identity unavailable",
  "browser did not retain the declared App page identity",
  "browser observation exceeds its bounds or has unsupported content",
  "browser checkout context is unavailable",
  "browser checkout mount does not match the assigned shared workspace",
  "browser checkout HEAD could not be established",
  "browser checkout modification state is unavailable",
  "browser screenshot publication was not confirmed",
  "Browser tools preparation was stopped",
  "Browser tools could not prepare the approved image: Sandbox storage is exhausted; release unused compute or retired storage before retrying this work",
  "Browser tools could not prepare the approved image; check registry connectivity and CA trust, then restart the Workspace",
  "Browser tools could not prepare the approved image; check Registry availability and approved access before retrying this work",
  "Browser observation does not match this execution scope",
]);

// An unknown renewal acknowledgement does not confirm authority loss. Only the
// existing ownership heartbeat may try again, through fresh dispatch validation.
// Confirmed Connector errors and all App calls keep their fail-closed behavior.
const transientRenewalFailures = new Set([
  "Runtime parent operation timed out",
  "Runtime parent is not ready",
  "Runtime parent connection changed before dispatch",
  "Runtime parent operation could not be sent",
  "Runtime channel disconnected",
]);

const reopenableFailures = new Set([
  "browser execution authority ended",
  "browser session is no longer active",
  "browser control connection ended",
  "browser session already ended; open a fresh browser session",
  "browser session requires owned cleanup after parent restart; do not replay a UI mutation",
  // A bounded tool wait does not revoke the admitted Build. Its UI outcome is
  // unknown, so only confirmed cleanup plus a new browser_open may recover it.
  // The new browser must still observe a snapshot before another App action.
  "browser tool exceeded its execution authority or deadline",
]);

function reopenableBrowserFailure(cause: unknown) {
  return (
    (cause instanceof RuntimeParentOperationError && reopenableFailures.has(cause.message)) ||
    (cause instanceof Error &&
      !(cause instanceof RuntimeParentOperationError) &&
      cause.message === "Runtime channel disconnected")
  );
}

export function createBuildBrowserController(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  secret: string,
  media = createReviewMedia(database),
) {
  const turns = createAgentTurnStore(database);
  const closing = new Map<string, Promise<void>>();
  const renewing = new Set<string>();
  const dispatchedCalls = new Map<string, Set<string>>();
  // Browser recovery closes old sessions on process restart. Losing this
  // ephemeral observation barrier never permits reusing an old browser.
  const needsObservation = new Set<string>();

  function capability(id: string) {
    return createHmac("sha256", secret).update(`factory-build-browser-v1:${id}`).digest("hex");
  }

  async function row(id: string) {
    const [session] = await database.db
      .select({
        id: buildBrowserSession.id,
        ordinal: buildBrowserSession.ordinal,
        turnID: buildBrowserSession.turnId,
        changeID: buildBrowserSession.changeId,
        attemptID: buildBrowserSession.runtimeAttemptId,
        generation: buildBrowserSession.generation,
        agentSessionID: buildBrowserSession.agentSessionId,
        ownerID: buildBrowserSession.ownerId,
        state: query<BrowserSession["state"]>`${buildBrowserSession.state}`,
      })
      .from(buildBrowserSession)
      .where(eq(buildBrowserSession.id, id));
    return session;
  }

  async function currentIn(
    sql: DatabaseTransaction,
    session: BrowserSession,
    ownerToken: string,
    purpose: "active" | "reopen" | "facade" = "active",
  ) {
    const started = performance.now();
    const [current] = await sql<Array<{ remainingMS: number; projectID: string; userID: string }>>`
      SELECT turn.project_id AS "projectID", turn.created_by AS "userID",
        EXTRACT(EPOCH FROM (turn.owner_expires_at - clock_timestamp()))::float8 * 1000 AS "remainingMS"
      FROM factory.build_browser_session browser
      JOIN factory.agent_turn turn ON turn.id = browser.turn_id
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
      JOIN factory.change_agent_session session ON session.change_id = browser.change_id
      JOIN factory.change change ON change.id = browser.change_id
      JOIN factory.runtime_attempt attempt ON attempt.id = browser.runtime_attempt_id
      WHERE browser.id = ${session.id}
        AND (${purpose === "facade"} OR browser.state IN ('intended', 'active') OR
          (${purpose === "reopen"} AND browser.state = 'closed' AND browser.reopen_allowed))
        AND turn.id = ${session.turnID} AND turn.owner_token = ${ownerToken}
        AND turn.owner_expires_at > clock_timestamp() AND turn.state IN ('dispatching', 'running')
        AND intent.runtime_attempt_id = browser.runtime_attempt_id AND intent.change_id = browser.change_id
        AND intent.session_id = browser.agent_session_id AND attempt.generation = browser.generation
        AND change.runtime_attempt_id = browser.runtime_attempt_id AND attempt.state = 'ready'
        AND session.runtime_attempt_id = browser.runtime_attempt_id AND session.active_turn_id = browser.turn_id
        AND session.opencode_session_id = browser.agent_session_id AND NOT session.stop_pending
        AND session.state IN ('starting', 'working') FOR UPDATE OF browser`;
    if (!current || ownerIdentity(ownerToken) !== session.ownerID)
      throw new CommandError("conflict", "Browser no longer owns this Build execution");
    await projectAuthorityIn(sql, current.userID, current.projectID);
    const remaining = Math.min(25_000, current.remainingMS - (performance.now() - started) - 250);
    if (remaining < 1_000)
      throw new CommandError("conflict", "Browser execution authority is expiring");
    return new Date(Date.now() + remaining).toISOString();
  }

  function operation(
    session: BrowserSession,
    action: string,
    expiresAt: string,
    call?: BuildBrowserCall | { name: "recording_chunk"; arguments: { offset: number } },
  ) {
    return {
      operationId: crypto.randomUUID(),
      action,
      runtimeAttemptId: session.attemptID,
      generation: session.generation,
      data: JSON.stringify({
        sessionId: session.id,
        turnId: session.turnID,
        agentSessionId: session.agentSessionID,
        ownerId: session.ownerID,
        expiresAt,
        call: call ?? { name: "", arguments: {} },
      }),
    };
  }

  async function close(id: string, cause?: unknown) {
    const previous = closing.get(id);
    if (previous) return previous;
    const summary =
      cause instanceof Error && safeBrowserFailures.has(cause.message)
        ? `Inspection ended: ${cause.message}`
        : null;
    const reopenAllowed = reopenableBrowserFailure(cause);
    const work = (async () => {
      await database.db
        .update(buildBrowserSession)
        .set({
          state: "closing",
          reopenAllowed,
          cleanupIntendedAt: query`COALESCE(${buildBrowserSession.cleanupIntendedAt}, now())`,
          outcomeSummary: query`COALESCE(${summary}, ${buildBrowserSession.outcomeSummary})`,
        })
        .where(
          and(
            eq(buildBrowserSession.id, id),
            inArray(buildBrowserSession.state, ["intended", "active"]),
          ),
        );
      const session = await row(id);
      if (!session || session.state === "closed") return;
      await database.db
        .update(reviewMedia)
        .set({
          state: "unavailable",
          reason: "Recording interrupted. App observations and QA results are retained separately.",
        })
        .where(
          and(
            eq(reviewMedia.browserSessionId, id),
            inArray(reviewMedia.state, ["intended", "recording"]),
          ),
        )
        .catch(() => {});
      needsObservation.delete(id);
      const ended = await database.db
        .update(buildBrowserSession)
        .set({
          state: "closed",
          cleanupConfirmedAt: query`now()`,
          outcomeSummary: query`CASE WHEN ${buildBrowserSession.outcomeSummary} LIKE 'Inspection ended: %'
          THEN ${buildBrowserSession.outcomeSummary} ELSE 'Exact Runtime Attempt teardown confirmed browser cleanup' END`,
        })
        .from(runtimeAttempt)
        .where(
          and(
            eq(buildBrowserSession.id, id),
            eq(buildBrowserSession.state, "closing"),
            eq(runtimeAttempt.id, buildBrowserSession.runtimeAttemptId),
            eq(runtimeAttempt.generation, buildBrowserSession.generation),
            eq(runtimeAttempt.state, "stopped"),
            isNotNull(runtimeAttempt.stoppedAt),
          ),
        )
        .returning({ id: buildBrowserSession.id });
      if (ended.length) return;
      try {
        await hub.parentOperation(
          session.attemptID,
          operation(session, "browser-close", new Date(0).toISOString()),
        );
        await database.db
          .update(buildBrowserSession)
          .set({
            state: "closed",
            cleanupConfirmedAt: query`now()`,
            outcomeSummary: query`CASE WHEN ${buildBrowserSession.outcomeSummary} LIKE 'Inspection ended: %'
            THEN ${buildBrowserSession.outcomeSummary} ELSE 'Exact owned browser and App proxy cleanup confirmed' END`,
          })
          .where(and(eq(buildBrowserSession.id, id), eq(buildBrowserSession.state, "closing")));
      } catch {
        // Disconnected is not absent. Keep the exact cleanup intent for the next
        // parent connection, even though independent leases already end access.
        await database.db
          .update(buildBrowserSession)
          .set({
            outcomeSummary: query`CASE WHEN ${buildBrowserSession.outcomeSummary} LIKE 'Inspection ended: %'
            THEN ${buildBrowserSession.outcomeSummary}
            ELSE 'Browser cleanup is unconfirmed; retry exact owned cleanup when the Connector returns' END`,
          })
          .where(and(eq(buildBrowserSession.id, id), eq(buildBrowserSession.state, "closing")));
      }
    })();
    closing.set(id, work);
    try {
      await work;
    } finally {
      closing.delete(id);
    }
  }

  async function dispatch(
    session: BrowserSession,
    ownerToken: string,
    action:
      | "browser-call"
      | "browser-renew"
      | "browser-recording-start"
      | "browser-recording-finish"
      | "browser-recording-chunk",
    call?: BuildBrowserCall | { name: "recording_chunk"; arguments: { offset: number } },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    let expiresAt: string | undefined;
    const admitted = await turns.validateExecution(session.turnID, ownerToken, async (sql) => {
      expiresAt = await currentIn(sql, session, ownerToken);
    });
    if (!admitted || !expiresAt)
      throw new CommandError("conflict", "Browser requires live Build authority");
    const payload = operation(session, action, expiresAt, call);
    return hub.parentOperation(session.attemptID, payload, async (send) => {
      const allowed = await turns.validateExecution(session.turnID, ownerToken, async (sql) => {
        await currentIn(sql, session, ownerToken);
        if (Date.parse(expiresAt ?? "") - Date.now() < 1_000)
          throw new CommandError(
            "conflict",
            "Browser dispatch lease expired while awaiting authority",
          );
        signal?.throwIfAborted();
        // Recheck Stop/current scope at the actual frame send, then release the
        // transaction before awaiting the browser. The lease cannot be extended
        // by a delayed frame or an unconfirmed outcome.
        send();
      });
      if (!allowed)
        throw new CommandError("conflict", "Browser Build authority changed before dispatch");
    });
  }

  async function dispatchCall(
    session: BrowserSession,
    ownerToken: string,
    call: BuildBrowserCall,
    signal?: AbortSignal,
  ) {
    // Match the Connector's existing 180-second image-preparation bound.
    // Each probe gets a fresh short authority lease. Only the exact confirmed
    // pre-execution response permits another probe; no App action is replayed.
    const preparationDeadline = performance.now() + 180_000;
    for (;;) {
      try {
        return await dispatch(session, ownerToken, "browser-call", call, signal);
      } catch (cause) {
        if (
          call.name !== "browser_open" ||
          !browserPreparing(cause) ||
          performance.now() >= preparationDeadline
        )
          throw cause;
        await delay(Math.min(1_000, preparationDeadline - performance.now()), undefined, {
          signal,
        });
      }
    }
  }

  async function authorizeSession(
    id: string,
    authorization: string | null,
    purpose: "active" | "reopen" | "facade" = "active",
  ) {
    const expected = `Bearer ${capability(id)}`;
    if (
      !authorization ||
      Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
    )
      return null;
    const session = await row(id);
    if (
      !session ||
      !(
        purpose === "facade" ||
        ["intended", "active"].includes(session.state) ||
        (purpose === "reopen" && session.state === "closed")
      )
    )
      return null;
    const [owner] = await database.db
      .select({ token: query<string>`${agentTurn.ownerToken}` })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.id, session.turnID),
          isNotNull(agentTurn.ownerToken),
          query`${agentTurn.ownerExpiresAt}>clock_timestamp()`,
          inArray(agentTurn.state, ["dispatching", "running"]),
        ),
      );
    if (!owner || ownerIdentity(owner.token) !== session.ownerID) return null;
    try {
      const allowed = await turns.validateExecution(session.turnID, owner.token, async (sql) => {
        await currentIn(sql, session, owner.token, purpose);
      });
      return allowed ? { session, ownerToken: owner.token } : null;
    } catch {
      return null;
    }
  }

  async function reopen(previous: BrowserSession, ownerToken: string) {
    const ordinal = previous.ordinal + 1;
    const id = browserIdentity(previous.turnID, previous.ownerID, ordinal);
    const allowed = await turns.validateExecution(previous.turnID, ownerToken, async (sql) => {
      await currentIn(sql, previous, ownerToken, "reopen");
      const db = drizzleTransaction(sql);
      await db
        .insert(buildBrowserSession)
        .select(
          db
            .select({
              id: query<string>`${id}::uuid`.as("id"),
              turnId: buildBrowserSession.turnId,
              changeId: buildBrowserSession.changeId,
              runtimeAttemptId: buildBrowserSession.runtimeAttemptId,
              generation: buildBrowserSession.generation,
              agentSessionId: buildBrowserSession.agentSessionId,
              ownerId: buildBrowserSession.ownerId,
              state: query<string>`'intended'::text`.as("state"),
              createIntendedAt: query<Date>`now()`.as("create_intended_at"),
              createConfirmedAt: query<null>`NULL::timestamptz`.as("create_confirmed_at"),
              cleanupIntendedAt: query<null>`NULL::timestamptz`.as("cleanup_intended_at"),
              cleanupConfirmedAt: query<null>`NULL::timestamptz`.as("cleanup_confirmed_at"),
              outcomeSummary: query<null>`NULL::text`.as("outcome_summary"),
              inspectionContext: query<null>`NULL::jsonb`.as("inspection_context"),
              ordinal: query<number>`${ordinal}::integer`.as("ordinal"),
              reopenAllowed: query<boolean>`false`.as("reopen_allowed"),
            })
            .from(buildBrowserSession)
            .where(
              and(
                eq(buildBrowserSession.id, previous.id),
                eq(buildBrowserSession.state, "closed"),
                eq(buildBrowserSession.reopenAllowed, true),
                isNotNull(buildBrowserSession.cleanupConfirmedAt),
              ),
            ),
        )
        .onConflictDoNothing();
    });
    const next = allowed ? await row(id) : undefined;
    if (!next || !["intended", "active"].includes(next.state))
      throw new CommandError(
        "conflict",
        "A fresh browser requires confirmed cleanup and current Build authority",
      );
    return next;
  }

  async function recordingFailure(id: string) {
    await database.db
      .update(reviewMedia)
      .set({
        state: "unavailable",
        reason: "QA recording unavailable. App observations and review results are separate.",
      })
      .where(and(eq(reviewMedia.id, id), inArray(reviewMedia.state, ["intended", "recording"])))
      .catch(() => {});
  }
  async function beginRecording(session: BrowserSession, ownerToken: string) {
    // Persist the fixed recording identity before asking upstream to create it.
    // Only independent review sessions record; implementation never does.
    let id: string | undefined;
    try {
      const allowed = await turns.validateExecution(session.turnID, ownerToken, async (sql) => {
        await currentIn(sql, session, ownerToken);
        const db = drizzleTransaction(sql);
        const [intent] = await db
          .insert(reviewMedia)
          .select(
            db
              .select({
                id: query<string>`${session.id}::uuid`.as("id"),
                changeId: candidateReview.changeId,
                reviewId: candidateReview.id,
                browserSessionId: query<string>`${session.id}::uuid`.as("browser_session_id"),
                createdBy: query<null>`NULL::uuid`.as("created_by"),
                kind: query<string>`'recording'::text`.as("kind"),
                commitSha: candidateReview.commitSha,
                runtimeAttemptId: query<string>`${session.attemptID}::uuid`.as(
                  "runtime_attempt_id",
                ),
                sourceContext: query<null>`NULL::jsonb`.as("source_context"),
                state: query<string>`'intended'::text`.as("state"),
                byteLength: query<null>`NULL::integer`.as("byte_length"),
                sha256: query<null>`NULL::text`.as("sha256"),
                durationMs: query<null>`NULL::integer`.as("duration_ms"),
                reason: query<null>`NULL::text`.as("reason"),
                createdAt: query<Date>`clock_timestamp()`.as("created_at"),
                completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
                deletedAt: query<null>`NULL::timestamptz`.as("deleted_at"),
              })
              .from(candidateReview)
              .where(
                and(
                  eq(candidateReview.turnId, session.turnID),
                  isNull(candidateReview.findingSourceId),
                ),
              ),
          )
          .onConflictDoNothing()
          .returning({ id: reviewMedia.id, state: reviewMedia.state });
        if (intent?.state === "intended") id = intent.id;
      });
      if (!allowed || !id) return;
      const output = await dispatch(session, ownerToken, "browser-recording-start");
      const started = z
        .object({ startedAt: z.iso.datetime() })
        .parse(JSON.parse(output.data ?? ""));
      await database.db
        .update(reviewMedia)
        .set({
          state: "recording",
          createdAt: query`${started.startedAt}::timestamptz`,
        })
        .where(and(eq(reviewMedia.id, id), eq(reviewMedia.state, "intended")));
    } catch {
      if (id) await recordingFailure(id);
      // Never turn a successful browser action into a retriable failure just
      // because recording was unavailable.
    }
  }

  return {
    async prepare(turnID: string, ownerToken: string) {
      const id = browserIdentity(turnID, ownerIdentity(ownerToken));
      const allowed = await turns.validateExecution(turnID, ownerToken, async (sql) => {
        const db = drizzleTransaction(sql);
        const [turn] = await db
          .select({ projectID: agentTurn.projectId, userID: agentTurn.createdBy })
          .from(agentTurn)
          .where(eq(agentTurn.id, turnID));
        if (!turn) throw new CommandError("conflict", "Build admission was not found");
        await projectAuthorityIn(sql, turn.userID, turn.projectID);
        await db
          .insert(buildBrowserSession)
          .select(
            db
              .select({
                id: query<string>`${id}::uuid`.as("id"),
                turnId: agentTurn.id,
                changeId: changeAgentTurnIntent.changeId,
                runtimeAttemptId: query<string>`${changeAgentTurnIntent.runtimeAttemptId}`.as(
                  "runtime_attempt_id",
                ),
                generation: runtimeAttempt.generation,
                agentSessionId: changeAgentTurnIntent.sessionId,
                ownerId: query<string>`${ownerIdentity(ownerToken)}::text`.as("owner_id"),
                state: query<string>`'intended'::text`.as("state"),
                createIntendedAt: query<Date>`now()`.as("create_intended_at"),
                createConfirmedAt: query<null>`NULL::timestamptz`.as("create_confirmed_at"),
                cleanupIntendedAt: query<null>`NULL::timestamptz`.as("cleanup_intended_at"),
                cleanupConfirmedAt: query<null>`NULL::timestamptz`.as("cleanup_confirmed_at"),
                outcomeSummary: query<null>`NULL::text`.as("outcome_summary"),
                inspectionContext: query<null>`NULL::jsonb`.as("inspection_context"),
                ordinal: query<number>`1::integer`.as("ordinal"),
                reopenAllowed: query<boolean>`false`.as("reopen_allowed"),
              })
              .from(agentTurn)
              .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
              .innerJoin(
                runtimeAttempt,
                eq(runtimeAttempt.id, changeAgentTurnIntent.runtimeAttemptId),
              )
              .where(eq(agentTurn.id, turnID)),
          )
          .onConflictDoNothing({
            target: [
              buildBrowserSession.turnId,
              buildBrowserSession.ownerId,
              buildBrowserSession.ordinal,
            ],
          });
      });
      const session = allowed ? await row(id) : undefined;
      if (!session || !["intended", "active"].includes(session.state))
        throw new CommandError("conflict", "Browser requires the current admitted Build execution");
      const [binding] = await database.db
        .select({ intent: substrateBinding.intent })
        .from(substrateBinding)
        .where(eq(substrateBinding.runtimeAttemptId, session.attemptID));
      return {
        sessionID: session.id,
        bearer: capability(session.id),
        runtimeEndpoint: substrateFactoryURL(
          `/internal/build-browser/${session.attemptID}/${turnID}`,
          binding?.intent,
        ),
        runtimeBearer: runtimeBuildBrowserToken(secret, session.attemptID, session.generation),
      };
    },

    async authorize(
      id: string,
      authorization: string | null,
      purpose: "browser" | "facade" = "browser",
    ) {
      return authorizeSession(id, authorization, purpose === "facade" ? "facade" : "active");
    },

    async authorizeRuntime(
      attemptID: string,
      turnID: string,
      authorization: string | null,
      purpose: "browser" | "facade" = "browser",
    ) {
      const [current] = await database.db
        .select({
          generation: runtimeAttempt.generation,
          ownerToken: query<string>`${agentTurn.ownerToken}`,
        })
        .from(runtimeAttempt)
        .innerJoin(agentTurn, eq(agentTurn.id, turnID))
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.state, "ready"),
            eq(runtimeAttempt.changeId, agentTurn.changeId),
            inArray(agentTurn.state, ["dispatching", "running"]),
            isNotNull(agentTurn.ownerToken),
            query`${agentTurn.ownerExpiresAt}>clock_timestamp()`,
          ),
        );
      if (!current) return null;
      const expected = `Bearer ${runtimeBuildBrowserToken(secret, attemptID, current.generation)}`;
      if (
        !authorization ||
        Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
      )
        return null;
      const [session] = await database.db
        .select({ id: buildBrowserSession.id })
        .from(buildBrowserSession)
        .where(
          and(
            eq(buildBrowserSession.runtimeAttemptId, attemptID),
            eq(buildBrowserSession.turnId, turnID),
            eq(buildBrowserSession.generation, current.generation),
            eq(buildBrowserSession.ownerId, ownerIdentity(current.ownerToken)),
          ),
        )
        .orderBy(desc(buildBrowserSession.ordinal))
        .limit(1);
      return session
        ? authorizeSession(
            session.id,
            `Bearer ${capability(session.id)}`,
            purpose === "facade" ? "facade" : "reopen",
          )
        : null;
    },

    async call(
      session: BrowserSession,
      ownerToken: string,
      input: unknown,
      requestID: string | number,
      signal?: AbortSignal,
    ): Promise<BuildBrowserResult> {
      const call = buildBrowserCallInput.parse(input);
      const [reported] = await database.db
        .select({ id: candidateReview.id })
        .from(candidateReview)
        .where(and(eq(candidateReview.turnId, session.turnID), isNotNull(candidateReview.result)));
      if (reported)
        throw new CommandError(
          "conflict",
          "Review report is already recorded. Finish this review without further App actions.",
        );
      const callKey = `${session.turnID}:${session.ownerID}`;
      const calls = dispatchedCalls.get(callKey) ?? new Set<string>();
      dispatchedCalls.set(callKey, calls);
      const identity = `${typeof requestID}:${requestID}`;
      if (calls.has(identity))
        throw new CommandError(
          "conflict",
          "This browser request was already dispatched. Check the App before issuing a new UI mutation.",
        );
      if (calls.size >= 128)
        throw new CommandError(
          "conflict",
          "This turn reached its 128 browser-call limit. Continue in a new authorized turn.",
        );
      const reopening = session.state === "closed";
      if (reopening) {
        if (call.name !== "browser_open")
          throw new CommandError(
            "conflict",
            "The previous browser ended. Use browser_open to start a fresh inspection, then inspect browser_snapshot. Never replay an unconfirmed App action.",
          );
        calls.add(identity);
        session = await reopen(session, ownerToken);
      }
      const freshInspection =
        session.ordinal > 1 && session.state === "intended" && call.name === "browser_open";
      if (
        needsObservation.has(session.id) &&
        ![
          "browser_snapshot",
          "browser_console",
          "browser_screenshot",
          "browser_wait",
          "browser_http_observations",
        ].includes(call.name)
      )
        throw new CommandError(
          "conflict",
          "Inspect a fresh browser_snapshot after the failed interaction before issuing another UI action. Do not replay an unconfirmed mutation.",
        );
      calls.add(identity);
      try {
        const output = await dispatchCall(session, ownerToken, call, signal);
        signal?.throwIfAborted();
        if (!output.data) throw new Error("Browser result unavailable");
        const parsed = buildBrowserResultInput.safeParse(JSON.parse(output.data));
        if (!parsed.success) throw new Error("Browser returned an invalid observation schema");
        const result = parsed.data;
        if (result.isError) {
          needsObservation.add(session.id);
          return {
            isError: true,
            content: [
              ...result.content.filter((item) => item.type === "text").slice(0, 15),
              {
                type: "text",
                text: "Inspect a fresh browser_snapshot before issuing another UI action. The existing browser remains available for observation, but no successful inspection is claimed by this error. Do not repeat navigation or replay an unconfirmed mutation.",
              },
            ],
          };
        }
        const context = result.structuredContent;
        if (
          !context ||
          context.sessionId !== session.id ||
          context.turnId !== session.turnID ||
          context.runtimeAttemptId !== session.attemptID ||
          context.generation !== session.generation
        )
          throw new Error("Browser observation does not match this execution scope");
        const inspection = { ...context, changeId: session.changeID };
        if (call.name === "browser_snapshot") needsObservation.delete(session.id);
        if (freshInspection) needsObservation.add(session.id);
        await database.db
          .update(buildBrowserSession)
          .set({
            state: "active",
            createConfirmedAt: query`COALESCE(${buildBrowserSession.createConfirmedAt}, now())`,
            inspectionContext: inspection,
          })
          .where(
            and(
              eq(buildBrowserSession.id, session.id),
              inArray(buildBrowserSession.state, ["intended", "active"]),
            ),
          );
        if (call.name === "browser_open" || session.state === "intended")
          await beginRecording(session, ownerToken);
        return {
          ...result,
          structuredContent: inspection,
          ...(freshInspection
            ? {
                content: [
                  ...result.content,
                  {
                    type: "text" as const,
                    text: "Factory opened a fresh browser after confirmed cleanup. Previous cookies and UI state were not restored. Inspect browser_snapshot before another action; do not replay any unconfirmed mutation.",
                  },
                ],
              }
            : {}),
        };
      } catch (cause) {
        // The pinned Connector returns this before creating a browser or calling
        // an App. It proves non-execution, unlike a lost response. Keep the
        // intended session so native tools can retry after the image is ready.
        if (call.name === "browser_open" && browserPreparing(cause))
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Browser tools did not finish preparation within their startup window. No App action ran. Check runtime image preparation before another browser_open.",
              },
            ],
          };
        await close(session.id, cause);
        const reason =
          cause instanceof Error && safeBrowserFailures.has(cause.message)
            ? `: ${cause.message}`
            : "";
        throw new CommandError(
          "conflict",
          `Browser inspection was not confirmed${reason}. Do not replay a UI mutation without checking the App; ${
            reopenableBrowserFailure(cause)
              ? "after exact cleanup is confirmed, use browser_open for a fresh browser and inspect browser_snapshot before another action."
              : "start a new authorized turn if its browser has ended."
          }`,
        );
      }
    },

    async finishRecording(session: BrowserSession, ownerToken: string, signal?: AbortSignal) {
      const [recording] = await database.db
        .select({ id: reviewMedia.id })
        .from(reviewMedia)
        .where(
          and(
            eq(reviewMedia.browserSessionId, session.id),
            eq(reviewMedia.kind, "recording"),
            eq(reviewMedia.state, "recording"),
          ),
        );
      if (!recording) return;
      try {
        const manifestInput = z.object({
          bytes: z.number().int().positive().max(maximumRecordingBytes),
          durationMs: z.number().int().nonnegative(),
          note: z.literal("Unchanged frames shortened.").optional(),
        });
        let manifest: z.infer<typeof manifestInput>;
        for (;;) {
          const output = await dispatch(
            session,
            ownerToken,
            "browser-recording-finish",
            undefined,
            signal,
          );
          const value: unknown = JSON.parse(output.data ?? "");
          if (z.strictObject({ state: z.literal("pending") }).safeParse(value).success) {
            await delay(500, undefined, { signal });
            continue;
          }
          manifest = manifestInput.parse(value);
          break;
        }
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < manifest.bytes; offset += 49_152) {
          const output = await dispatch(
            session,
            ownerToken,
            "browser-recording-chunk",
            { name: "recording_chunk", arguments: { offset } },
            signal,
          );
          const chunk = z
            .object({ offset: z.number().int(), data: z.string().max(65_536) })
            .parse(JSON.parse(output.data ?? ""));
          const bytes = Buffer.from(chunk.data, "base64");
          if (
            chunk.offset !== offset ||
            bytes.byteLength !== Math.min(49_152, manifest.bytes - offset)
          )
            throw new Error("Recording chunk did not match its manifest");
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.readUInt32BE(0) !== 0x1a45dfa3) throw new Error("Recording is not WebM");
        // Slow state-volume I/O must not hold the turn lock and starve its
        // ownership heartbeat. Publication is a separate, short fenced commit.
        const proof = await media.stage(recording.id, bytes);
        signal?.throwIfAborted();
        await turns.validateExecution(session.turnID, ownerToken, async (sql) => {
          await currentIn(sql, session, ownerToken);
          await media.complete(proof, manifest.durationMs, sql, manifest.note);
          await currentIn(sql, session, ownerToken);
        });
      } catch {
        await recordingFailure(recording.id);
      }
    },

    async finishTurnRecording(turnID: string, ownerToken: string, signal?: AbortSignal) {
      try {
        const [latest] = await database.db
          .select({ id: buildBrowserSession.id })
          .from(buildBrowserSession)
          .where(
            and(
              eq(buildBrowserSession.turnId, turnID),
              eq(buildBrowserSession.ownerId, ownerIdentity(ownerToken)),
              eq(buildBrowserSession.state, "active"),
            ),
          )
          .orderBy(desc(buildBrowserSession.ordinal))
          .limit(1);
        const session = latest ? await row(latest.id) : undefined;
        if (session) await this.finishRecording(session, ownerToken, signal);
      } catch {
        // Media failure must not change the QA verdict or block exact cleanup.
      }
    },

    async renewTurn(turnID: string, ownerToken: string) {
      if (renewing.has(turnID)) return;
      renewing.add(turnID);
      try {
        const [session] = await database.db
          .select({ id: buildBrowserSession.id })
          .from(buildBrowserSession)
          .where(
            and(
              eq(buildBrowserSession.turnId, turnID),
              eq(buildBrowserSession.ownerId, ownerIdentity(ownerToken)),
              inArray(buildBrowserSession.state, ["intended", "active"]),
            ),
          );
        if (!session) return;
        const current = await row(session.id);
        if (!current) return;
        try {
          await dispatch(current, ownerToken, "browser-renew");
        } catch (cause) {
          if (
            cause instanceof Error &&
            !(cause instanceof RuntimeParentOperationError) &&
            transientRenewalFailures.has(cause.message)
          )
            return;
          await close(current.id, cause);
        }
      } finally {
        renewing.delete(turnID);
      }
    },

    async closeTurn(turnID: string) {
      await database.db
        .update(reviewMedia)
        .set({
          state: "unavailable",
          reason: "Recording interrupted. No App actions were repeated.",
        })
        .where(
          and(
            inArray(
              reviewMedia.browserSessionId,
              database.db
                .select({ id: buildBrowserSession.id })
                .from(buildBrowserSession)
                .where(eq(buildBrowserSession.turnId, turnID)),
            ),
            inArray(reviewMedia.state, ["intended", "recording"]),
          ),
        )
        .catch(() => {});
      const sessions = await database.db
        .select({ id: buildBrowserSession.id, ownerID: buildBrowserSession.ownerId })
        .from(buildBrowserSession)
        .where(eq(buildBrowserSession.turnId, turnID));
      await Promise.all(sessions.map(({ id }) => close(id)));
      for (const session of sessions) dispatchedCalls.delete(`${turnID}:${session.ownerID}`);
    },

    async closeChange(changeID: string) {
      const sessions = await database.db
        .select({ id: buildBrowserSession.id })
        .from(buildBrowserSession)
        .where(
          and(eq(buildBrowserSession.changeId, changeID), ne(buildBrowserSession.state, "closed")),
        );
      await Promise.all(sessions.map(({ id }) => close(id)));
    },

    async reconcileCleanup() {
      const sessions = await database.db
        .select({ id: buildBrowserSession.id })
        .from(buildBrowserSession)
        .where(eq(buildBrowserSession.state, "closing"));
      await Promise.all(sessions.map(({ id }) => close(id)));
    },

    async recover(attemptID?: string) {
      const sessions = await database.db
        .select({ id: buildBrowserSession.id })
        .from(buildBrowserSession)
        .where(
          and(
            ne(buildBrowserSession.state, "closed"),
            attemptID === undefined
              ? undefined
              : and(
                  eq(buildBrowserSession.runtimeAttemptId, attemptID),
                  eq(buildBrowserSession.state, "closing"),
                ),
          ),
        );
      await Promise.all(sessions.map(({ id }) => close(id)));
    },
  };
}
