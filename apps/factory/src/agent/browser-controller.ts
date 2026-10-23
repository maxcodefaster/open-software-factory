import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type BuildBrowserCall,
  type BuildBrowserResult,
  buildBrowserCallInput,
  buildBrowserResultInput,
} from "../../../../packages/conversation-domain/src/browser-tools";
import type { createDatabase } from "../../../../packages/db/src/client";
import { runtimeBuildBrowserToken } from "../../../../packages/runtime-domain/src/identity";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { runtimeFactoryURL } from "../runtime/endpoints";
import { type RuntimeHub, RuntimeParentOperationError } from "../runtime/hub";
import { type AgentTurnTransaction, createAgentTurnStore } from "./turn-store";
import { createReviewMedia, maximumRecordingBytes } from "../review/media";
import { z } from "zod";

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
    const [session] = await database.client<BrowserSession[]>`
      SELECT id, ordinal, turn_id AS "turnID", change_id AS "changeID", runtime_attempt_id AS "attemptID",
        generation::float8 AS generation, agent_session_id AS "agentSessionID", owner_id AS "ownerID", state
      FROM factory.build_browser_session WHERE id = ${id}`;
    return session;
  }

  async function currentIn(
    sql: AgentTurnTransaction,
    session: BrowserSession,
    ownerToken: string,
    allowClosed = false,
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
        AND (browser.state IN ('intended', 'active') OR
          (${allowClosed} AND browser.state = 'closed' AND browser.reopen_allowed))
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
      await database.client`UPDATE factory.build_browser_session SET state = 'closing',
        reopen_allowed = ${reopenAllowed},
        cleanup_intended_at = COALESCE(cleanup_intended_at, now()),
        outcome_summary = COALESCE(${summary}, outcome_summary)
        WHERE id = ${id} AND state IN ('intended', 'active')`;
      const session = await row(id);
      if (!session || session.state === "closed") return;
      await database.client`UPDATE factory.review_media SET state='unavailable',
        reason='Recording interrupted. App observations and QA results are retained separately.'
        WHERE browser_session_id=${id} AND state IN ('intended','recording')`.catch(() => {});
      needsObservation.delete(id);
      try {
        await hub.parentOperation(
          session.attemptID,
          operation(session, "browser-close", new Date(0).toISOString()),
        );
        await database.client`UPDATE factory.build_browser_session SET state = 'closed',
          cleanup_confirmed_at = now(), outcome_summary = CASE
            WHEN outcome_summary LIKE 'Inspection ended: %' THEN outcome_summary
            ELSE 'Exact owned browser and App proxy cleanup confirmed' END
          WHERE id = ${id} AND state = 'closing'`;
      } catch {
        // Disconnected is not absent. Keep the exact cleanup intent for the next
        // parent connection, even though independent leases already end access.
        await database.client`UPDATE factory.build_browser_session
          SET outcome_summary = CASE
            WHEN outcome_summary LIKE 'Inspection ended: %' THEN outcome_summary
            ELSE 'Browser cleanup is unconfirmed; retry exact owned cleanup when the Connector returns' END
          WHERE id = ${id} AND state = 'closing'`;
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

  async function authorizeSession(id: string, authorization: string | null, allowClosed = false) {
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
        ["intended", "active"].includes(session.state) ||
        (allowClosed && session.state === "closed")
      )
    )
      return null;
    const [owner] = await database.client<Array<{ token: string }>>`
      SELECT owner_token AS token FROM factory.agent_turn WHERE id = ${session.turnID}
        AND owner_token IS NOT NULL AND owner_expires_at > clock_timestamp()
        AND state IN ('dispatching', 'running')`;
    if (!owner || ownerIdentity(owner.token) !== session.ownerID) return null;
    try {
      const allowed = await turns.validateExecution(session.turnID, owner.token, async (sql) => {
        await currentIn(sql, session, owner.token, allowClosed);
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
      await currentIn(sql, previous, ownerToken, true);
      await sql`INSERT INTO factory.build_browser_session(
        id,ordinal,turn_id,change_id,runtime_attempt_id,generation,agent_session_id,owner_id)
        SELECT ${id},${ordinal},turn_id,change_id,runtime_attempt_id,generation,agent_session_id,owner_id
        FROM factory.build_browser_session WHERE id=${previous.id}
          AND state='closed' AND reopen_allowed AND cleanup_confirmed_at IS NOT NULL
        ON CONFLICT DO NOTHING`;
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
    await database.client`UPDATE factory.review_media SET state='unavailable',
      reason='QA recording unavailable. App observations and review results are separate.'
      WHERE id=${id} AND state IN ('intended','recording')`.catch(() => {});
  }
  async function beginRecording(session: BrowserSession, ownerToken: string) {
    // Persist the fixed recording identity before asking upstream to create it.
    // Only independent review sessions record; implementation never does.
    let id: string | undefined;
    try {
      const allowed = await turns.validateExecution(session.turnID, ownerToken, async (sql) => {
        await currentIn(sql, session, ownerToken);
        const [intent] = await sql<{ id: string; state: string }[]>`
          INSERT INTO factory.review_media(id,change_id,review_id,browser_session_id,kind,commit_sha,runtime_attempt_id,state,reason)
          SELECT ${session.id},review.change_id,review.id,${session.id},'recording',review.commit_sha,
            ${session.attemptID},CASE WHEN project.qa_recording_enabled THEN 'intended' ELSE 'unavailable' END,
            CASE WHEN NOT project.qa_recording_enabled THEN 'Recording is disabled for this Project' END
          FROM factory.candidate_review review JOIN factory.change change ON change.id=review.change_id
          JOIN factory.project project ON project.id=change.project_id WHERE review.turn_id=${session.turnID}
          ON CONFLICT DO NOTHING RETURNING id,state`;
        if (intent?.state === "intended") id = intent.id;
      });
      if (!allowed || !id) return;
      const output = await dispatch(session, ownerToken, "browser-recording-start");
      const started = z
        .object({ startedAt: z.iso.datetime() })
        .parse(JSON.parse(output.data ?? ""));
      await database.client`UPDATE factory.review_media SET state='recording',created_at=${started.startedAt}
        WHERE id=${id} AND state='intended'`;
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
        const [turn] = await sql<Array<{ projectID: string; userID: string }>>`
          SELECT project_id AS "projectID", created_by AS "userID" FROM factory.agent_turn WHERE id = ${turnID}`;
        if (!turn) throw new CommandError("conflict", "Build admission was not found");
        await projectAuthorityIn(sql, turn.userID, turn.projectID);
        await sql`INSERT INTO factory.build_browser_session(id, turn_id, change_id, runtime_attempt_id,
          generation, agent_session_id, owner_id)
          SELECT ${id}, turn.id, intent.change_id, intent.runtime_attempt_id, attempt.generation,
            intent.session_id, ${ownerIdentity(ownerToken)}
          FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
          JOIN factory.runtime_attempt attempt ON attempt.id = intent.runtime_attempt_id
          WHERE turn.id = ${turnID} ON CONFLICT (turn_id, owner_id, ordinal) DO NOTHING`;
      });
      const session = allowed ? await row(id) : undefined;
      if (!session || !["intended", "active"].includes(session.state))
        throw new CommandError("conflict", "Browser requires the current admitted Build execution");
      return {
        sessionID: session.id,
        bearer: capability(session.id),
        runtimeEndpoint: runtimeFactoryURL(
          `/internal/build-browser/${session.attemptID}/${turnID}`,
        ),
        runtimeBearer: runtimeBuildBrowserToken(secret, session.attemptID, session.generation),
      };
    },

    async authorize(id: string, authorization: string | null) {
      return authorizeSession(id, authorization);
    },

    async authorizeRuntime(attemptID: string, turnID: string, authorization: string | null) {
      const [current] = await database.client<Array<{ generation: number; ownerToken: string }>>`
        SELECT attempt.generation::float8 AS generation, turn.owner_token AS "ownerToken"
        FROM factory.runtime_attempt attempt JOIN factory.agent_turn turn ON turn.id = ${turnID}
        WHERE attempt.id = ${attemptID} AND attempt.state = 'ready' AND attempt.change_id = turn.change_id
          AND turn.state IN ('dispatching', 'running') AND turn.owner_token IS NOT NULL
          AND turn.owner_expires_at > clock_timestamp()`;
      if (!current) return null;
      const expected = `Bearer ${runtimeBuildBrowserToken(secret, attemptID, current.generation)}`;
      if (
        !authorization ||
        Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
      )
        return null;
      const [session] = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.build_browser_session WHERE runtime_attempt_id = ${attemptID}
          AND turn_id = ${turnID} AND generation = ${current.generation}
          AND owner_id = ${ownerIdentity(current.ownerToken)}
        ORDER BY ordinal DESC LIMIT 1`;
      return session
        ? authorizeSession(session.id, `Bearer ${capability(session.id)}`, true)
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
      const [reported] = await database.client`SELECT id FROM factory.candidate_review
        WHERE turn_id=${session.turnID} AND result IS NOT NULL`;
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
        !["browser_snapshot", "browser_console", "browser_screenshot", "browser_wait"].includes(
          call.name,
        )
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
        await database.client`UPDATE factory.build_browser_session SET state = 'active',
          create_confirmed_at = COALESCE(create_confirmed_at, now()), inspection_context = ${JSON.stringify(inspection)}::jsonb
          WHERE id = ${session.id} AND state IN ('intended','active')`;
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

    async finishRecording(session: BrowserSession, ownerToken: string) {
      const [recording] = await database.client<
        { id: string }[]
      >`SELECT id FROM factory.review_media
        WHERE browser_session_id=${session.id} AND kind='recording' AND state='recording'`;
      if (!recording) return;
      try {
        const output = await dispatch(session, ownerToken, "browser-recording-finish");
        const manifest = z
          .object({
            bytes: z.number().int().positive().max(maximumRecordingBytes),
            durationMs: z.number().int().nonnegative(),
          })
          .parse(JSON.parse(output.data ?? ""));
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < manifest.bytes; offset += 49_152) {
          const output = await dispatch(session, ownerToken, "browser-recording-chunk", {
            name: "recording_chunk",
            arguments: { offset },
          });
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
        await turns.validateExecution(session.turnID, ownerToken, async (sql) => {
          await currentIn(sql, session, ownerToken);
          const [enabled] = await sql`SELECT project.id FROM factory.project project
            JOIN factory.change change ON change.project_id=project.id
            WHERE change.id=${session.changeID} AND project.qa_recording_enabled FOR SHARE OF project`;
          if (!enabled) throw new Error("Recording disabled");
          await media.complete(proof, manifest.durationMs, sql);
          await currentIn(sql, session, ownerToken);
        });
        await media.sweep();
      } catch {
        await recordingFailure(recording.id);
      }
    },

    async finishTurnRecording(turnID: string, ownerToken: string) {
      try {
        const [latest] = await database.client<
          { id: string }[]
        >`SELECT id FROM factory.build_browser_session
        WHERE turn_id=${turnID} AND owner_id=${ownerIdentity(ownerToken)}
          AND state='active' ORDER BY ordinal DESC LIMIT 1`;
        const session = latest ? await row(latest.id) : undefined;
        if (session) await this.finishRecording(session, ownerToken);
      } catch {
        // Media failure must not change the QA verdict or block exact cleanup.
      }
    },

    async renewTurn(turnID: string, ownerToken: string) {
      if (renewing.has(turnID)) return;
      renewing.add(turnID);
      try {
        const [session] = await database.client<Array<{ id: string }>>`
          SELECT id FROM factory.build_browser_session WHERE turn_id = ${turnID}
            AND owner_id = ${ownerIdentity(ownerToken)} AND state IN ('intended', 'active')`;
        if (!session) return;
        const current = await row(session.id);
        if (!current) return;
        try {
          await dispatch(current, ownerToken, "browser-renew");
          try {
            const [disabled] = await database.client`SELECT media.id FROM factory.review_media media
            JOIN factory.change change ON change.id=media.change_id
            JOIN factory.project project ON project.id=change.project_id
            WHERE media.browser_session_id=${current.id} AND media.state='recording'
              AND NOT project.qa_recording_enabled`;
            if (disabled) {
              try {
                await dispatch(current, ownerToken, "browser-recording-finish");
              } catch {
                /* Never replay browser work. */
              }
              await recordingFailure(current.id);
            }
          } catch {
            /* Recording diagnostics cannot revoke an otherwise valid QA browser. */
          }
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
      await database.client`UPDATE factory.review_media SET state='unavailable',
        reason='Recording interrupted. No App actions were repeated.'
        WHERE browser_session_id IN (SELECT id FROM factory.build_browser_session WHERE turn_id=${turnID})
          AND state IN ('intended','recording')`.catch(() => {});
      const sessions = await database.client<Array<{ id: string; ownerID: string }>>`
        SELECT id,owner_id AS "ownerID" FROM factory.build_browser_session WHERE turn_id = ${turnID}`;
      await Promise.all(sessions.map(({ id }) => close(id)));
      for (const session of sessions) dispatchedCalls.delete(`${turnID}:${session.ownerID}`);
    },

    async closeChange(changeID: string) {
      const sessions = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.build_browser_session WHERE change_id = ${changeID} AND state <> 'closed'`;
      await Promise.all(sessions.map(({ id }) => close(id)));
    },

    async recover(attemptID?: string) {
      const sessions = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.build_browser_session WHERE state <> 'closed'
          AND (${attemptID ?? null}::uuid IS NULL OR
            (runtime_attempt_id = ${attemptID ?? null}::uuid AND state = 'closing'))`;
      await Promise.all(sessions.map(({ id }) => close(id)));
    },
  };
}
