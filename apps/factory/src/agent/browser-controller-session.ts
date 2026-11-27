import { and, desc, eq, inArray, isNotNull, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, buildBrowserSession, changeAgentTurnIntent, runtimeAttempt } from "#db/schema";
import { runtimeBuildBrowserToken } from "#runtime-domain/identity";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { substrateFactoryURL } from "../runtime/endpoints";
import {
  type BrowserAuthorizationPurpose,
  type BrowserControllerDatabase,
  type BrowserNativeClient,
  type BrowserSession,
  type BrowserTurnStore,
  browserIdentity,
  classifyBrowserSession,
  isLiveBrowserPhase,
  isSessionUsableForPurpose,
  matchesBearer,
  ownerIdentity,
  sessionCapability,
} from "./browser-controller-types";

export type BrowserSessionContext = {
  database: BrowserControllerDatabase;
  secret: string;
  turns: BrowserTurnStore;
  native: BrowserNativeClient;
};

const browserSessionSelection = {
  id: buildBrowserSession.id,
  ordinal: buildBrowserSession.ordinal,
  turnID: buildBrowserSession.turnId,
  changeID: buildBrowserSession.changeId,
  attemptID: buildBrowserSession.runtimeAttemptId,
  generation: buildBrowserSession.generation,
  agentSessionID: buildBrowserSession.agentSessionId,
  ownerID: buildBrowserSession.ownerId,
  state: query<BrowserSession["state"]>`${buildBrowserSession.state}`,
};

const intendedSessionDefaults = {
  state: query<string>`'intended'::text`.as("state"),
  createIntendedAt: query<Date>`now()`.as("create_intended_at"),
  createConfirmedAt: query<null>`NULL::timestamptz`.as("create_confirmed_at"),
  cleanupIntendedAt: query<null>`NULL::timestamptz`.as("cleanup_intended_at"),
  cleanupConfirmedAt: query<null>`NULL::timestamptz`.as("cleanup_confirmed_at"),
  outcomeSummary: query<null>`NULL::text`.as("outcome_summary"),
  inspectionContext: query<null>`NULL::jsonb`.as("inspection_context"),
};

export async function readBrowserSession(
  database: BrowserControllerDatabase,
  id: string,
): Promise<BrowserSession | undefined> {
  const [session] = await database.db
    .select(browserSessionSelection)
    .from(buildBrowserSession)
    .where(eq(buildBrowserSession.id, id));
  return session;
}

export async function validateBrowserAuthorityIn(
  sql: DatabaseTransaction,
  session: BrowserSession,
  ownerToken: string,
  purpose: BrowserAuthorizationPurpose = "active",
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
  if (!current || ownerIdentity(ownerToken) !== session.ownerID) {
    throw new CommandError("conflict", "Browser no longer owns this Build execution");
  }
  await projectAuthorityIn(sql, current.userID, current.projectID);
  const remaining = Math.min(25_000, current.remainingMS - (performance.now() - started) - 250);
  if (remaining < 1_000) {
    throw new CommandError("conflict", "Browser execution authority is expiring");
  }
  return new Date(Date.now() + remaining).toISOString();
}

export async function prepareBrowserSession(
  ctx: BrowserSessionContext,
  turnID: string,
  ownerToken: string,
) {
  const ownerID = ownerIdentity(ownerToken);
  const id = browserIdentity(turnID, ownerID);
  const allowed = await ctx.turns.validateExecution(turnID, ownerToken, async (sql) => {
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
            ownerId: query<string>`${ownerID}::text`.as("owner_id"),
            ...intendedSessionDefaults,
            ordinal: query<number>`1::integer`.as("ordinal"),
            reopenAllowed: query<boolean>`false`.as("reopen_allowed"),
          })
          .from(agentTurn)
          .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
          .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentTurnIntent.runtimeAttemptId))
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
  const session = allowed ? await readBrowserSession(ctx.database, id) : undefined;
  if (!session || !isLiveBrowserPhase(classifyBrowserSession(session))) {
    throw new CommandError("conflict", "Browser requires the current admitted Build execution");
  }
  const [binding] = await ctx.database.db
    .select({ intent: runtimeAttempt.bindingIntent })
    .from(runtimeAttempt)
    .where(and(eq(runtimeAttempt.id, session.attemptID), isNotNull(runtimeAttempt.atespace)));
  return {
    sessionID: session.id,
    bearer: sessionCapability(ctx.secret, session.id),
    runtimeEndpoint: substrateFactoryURL(
      `/internal/build-browser/${session.attemptID}/${turnID}`,
      binding?.intent,
    ),
    runtimeBearer: runtimeBuildBrowserToken(ctx.secret, session.attemptID, session.generation),
  };
}

export async function authorizeBrowserSession(
  ctx: BrowserSessionContext,
  id: string,
  authorization: string | null,
  purpose: BrowserAuthorizationPurpose = "active",
) {
  if (!matchesBearer(authorization, sessionCapability(ctx.secret, id))) return null;
  const session = await readBrowserSession(ctx.database, id);
  if (!session || !isSessionUsableForPurpose(classifyBrowserSession(session), purpose)) {
    return null;
  }
  const [owner] = await ctx.database.db
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
    const allowed = await ctx.turns.validateExecution(session.turnID, owner.token, async (sql) => {
      await validateBrowserAuthorityIn(sql, session, owner.token, purpose);
    });
    return allowed ? { session, ownerToken: owner.token } : null;
  } catch {
    return null;
  }
}

export async function authorizeRuntimeBrowser(
  ctx: BrowserSessionContext,
  attemptID: string,
  turnID: string,
  authorization: string | null,
  purpose: "browser" | "facade" = "browser",
) {
  const [current] = await ctx.database.db
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
  if (
    !matchesBearer(
      authorization,
      runtimeBuildBrowserToken(ctx.secret, attemptID, current.generation),
    )
  ) {
    return null;
  }
  const [session] = await ctx.database.db
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
    ? authorizeBrowserSession(
        ctx,
        session.id,
        `Bearer ${sessionCapability(ctx.secret, session.id)}`,
        purpose === "facade" ? "facade" : "reopen",
      )
    : null;
}

export async function reopenBrowserSession(
  ctx: BrowserSessionContext,
  previous: BrowserSession,
  ownerToken: string,
) {
  const ordinal = previous.ordinal + 1;
  const id = browserIdentity(previous.turnID, previous.ownerID, ordinal);
  const allowed = await ctx.turns.validateExecution(previous.turnID, ownerToken, async (sql) => {
    await validateBrowserAuthorityIn(sql, previous, ownerToken, "reopen");
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
            ...intendedSessionDefaults,
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
  const next = allowed ? await readBrowserSession(ctx.database, id) : undefined;
  if (!next || !isLiveBrowserPhase(classifyBrowserSession(next))) {
    throw new CommandError(
      "conflict",
      "A fresh browser requires confirmed cleanup and current Build authority",
    );
  }
  return next;
}
