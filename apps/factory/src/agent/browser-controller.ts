import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type BuildBrowserCall,
  type BuildBrowserResult,
  buildBrowserCallInput,
  buildBrowserResultInput,
} from "../../../../packages/conversation-domain/src/browser-tools";
import { CommandError } from "../command-error";
import { RuntimeParentOperationError, type RuntimeHub } from "../runtime/hub";
import { projectAuthorityIn } from "../access/controller";
import { runtimeBuildBrowserToken } from "../../../../packages/runtime-domain/src/identity";
import { createAgentTurnStore, type AgentTurnTransaction } from "./turn-store";

type BrowserSession = {
  id: string;
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

function browserIdentity(turnID: string, ownerID: string) {
  const hex = createHash("sha256").update(`factory-browser-v1:${turnID}:${ownerID}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
  "Browser observation does not match this execution scope",
]);

export function createBuildBrowserController(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  secret: string,
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
      SELECT id, turn_id AS "turnID", change_id AS "changeID", runtime_attempt_id AS "attemptID",
        generation::float8 AS generation, agent_session_id AS "agentSessionID", owner_id AS "ownerID", state
      FROM factory.build_browser_session WHERE id = ${id}`;
    return session;
  }

  async function currentIn(sql: AgentTurnTransaction, session: BrowserSession, ownerToken: string) {
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
      WHERE browser.id = ${session.id} AND browser.state IN ('intended', 'active')
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
    call?: BuildBrowserCall,
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

  async function close(id: string) {
    const previous = closing.get(id);
    if (previous) return previous;
    const work = (async () => {
      await database.client`UPDATE factory.build_browser_session SET state = 'closing',
        cleanup_intended_at = COALESCE(cleanup_intended_at, now()), outcome_summary = NULL
        WHERE id = ${id} AND state IN ('intended', 'active')`;
      const session = await row(id);
      if (!session || session.state === "closed") return;
      dispatchedCalls.delete(id);
      needsObservation.delete(id);
      try {
        await hub.parentOperation(
          session.attemptID,
          operation(session, "browser-close", new Date(0).toISOString()),
        );
        await database.client`UPDATE factory.build_browser_session SET state = 'closed',
          cleanup_confirmed_at = now(), outcome_summary = 'Exact owned browser and App proxy cleanup confirmed'
          WHERE id = ${id} AND state = 'closing'`;
      } catch {
        // Disconnected is not absent. Keep the exact cleanup intent for the next
        // parent connection, even though independent leases already end access.
        await database.client`UPDATE factory.build_browser_session
          SET outcome_summary = 'Browser cleanup is unconfirmed; retry exact owned cleanup when the Connector returns'
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
    action: "browser-call" | "browser-renew",
    call?: BuildBrowserCall,
  ) {
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
        // Recheck Stop/current scope at the actual frame send, then release the
        // transaction before awaiting the browser. The lease cannot be extended
        // by a delayed frame or an unconfirmed outcome.
        send();
      });
      if (!allowed)
        throw new CommandError("conflict", "Browser Build authority changed before dispatch");
    });
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
          WHERE turn.id = ${turnID} ON CONFLICT (turn_id, owner_id) DO NOTHING`;
      });
      const session = allowed ? await row(id) : undefined;
      if (!session || !["intended", "active"].includes(session.state))
        throw new CommandError("conflict", "Browser requires the current admitted Build execution");
      return { sessionID: session.id, bearer: capability(session.id) };
    },

    async authorize(id: string, authorization: string | null) {
      const expected = `Bearer ${capability(id)}`;
      if (
        !authorization ||
        Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
      )
        return null;
      const session = await row(id);
      if (!session || !["intended", "active"].includes(session.state)) return null;
      const [owner] = await database.client<Array<{ token: string }>>`
        SELECT owner_token AS token FROM factory.agent_turn WHERE id = ${session.turnID}
          AND owner_token IS NOT NULL AND owner_expires_at > clock_timestamp()
          AND state IN ('dispatching', 'running')`;
      if (!owner || ownerIdentity(owner.token) !== session.ownerID) return null;
      try {
        const allowed = await turns.validateExecution(session.turnID, owner.token, async (sql) => {
          await currentIn(sql, session, owner.token);
        });
        return allowed ? { session, ownerToken: owner.token } : null;
      } catch {
        return null;
      }
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
          AND owner_id = ${ownerIdentity(current.ownerToken)} AND state IN ('intended', 'active')`;
      return session ? this.authorize(session.id, `Bearer ${capability(session.id)}`) : null;
    },

    async call(
      session: BrowserSession,
      ownerToken: string,
      input: unknown,
      requestID: string | number,
    ): Promise<BuildBrowserResult> {
      const call = buildBrowserCallInput.parse(input);
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
      const calls = dispatchedCalls.get(session.id) ?? new Set<string>();
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
      calls.add(identity);
      dispatchedCalls.set(session.id, calls);
      try {
        const output = await dispatch(session, ownerToken, "browser-call", call);
        if (!output.data) throw new Error("Browser result unavailable");
        const parsed = buildBrowserResultInput.safeParse(JSON.parse(output.data));
        if (!parsed.success) throw new Error("Browser returned an invalid observation schema");
        const result = parsed.data;
        if (result.isError) {
          if (session.state === "active") {
            needsObservation.add(session.id);
            return {
              isError: true,
              content: [
                ...result.content.filter((item) => item.type === "text").slice(0, 15),
                {
                  type: "text",
                  text: "Inspect a fresh browser_snapshot before issuing another UI action. The existing browser remains available; do not replay an unconfirmed mutation.",
                },
              ],
            };
          }
          await close(session.id);
          return { isError: true, content: result.content.filter((item) => item.type === "text") };
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
        await database.client`UPDATE factory.build_browser_session SET state = 'active',
          create_confirmed_at = COALESCE(create_confirmed_at, now()), inspection_context = ${JSON.stringify(inspection)}::jsonb
          WHERE id = ${session.id} AND state IN ('intended','active')`;
        return { ...result, structuredContent: inspection };
      } catch (cause) {
        // The pinned Connector returns this before creating a browser or calling
        // an App. It proves non-execution, unlike a lost response. Keep the
        // intended session so native tools can retry after the image is ready.
        if (
          call.name === "browser_open" &&
          cause instanceof RuntimeParentOperationError &&
          cause.action === "browser-call" &&
          cause.message ===
            "Browser tools are preparing; retry browser inspection after preparation completes"
        )
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Browser tools are preparing. No App action ran. Wait a few seconds, then retry browser_open in this same turn.",
              },
            ],
          };
        await close(session.id);
        const reason =
          cause instanceof Error && safeBrowserFailures.has(cause.message)
            ? `: ${cause.message}`
            : "";
        throw new CommandError(
          "conflict",
          `Browser inspection was not confirmed${reason}. Do not replay a UI mutation without checking the App; start a new authorized turn if its browser has ended.`,
        );
      }
    },

    async renewTurn(turnID: string, ownerToken: string) {
      if (renewing.has(turnID)) return;
      renewing.add(turnID);
      try {
        const [session] = await database.client<Array<{ id: string }>>`
          SELECT id FROM factory.build_browser_session WHERE turn_id = ${turnID}
            AND owner_id = ${ownerIdentity(ownerToken)} AND state = 'active'`;
        if (!session) return;
        const current = await row(session.id);
        if (!current) return;
        try {
          await dispatch(current, ownerToken, "browser-renew");
        } catch {
          await close(current.id);
        }
      } finally {
        renewing.delete(turnID);
      }
    },

    async closeTurn(turnID: string) {
      const sessions = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.build_browser_session WHERE turn_id = ${turnID} AND state <> 'closed'`;
      await Promise.all(sessions.map(({ id }) => close(id)));
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
