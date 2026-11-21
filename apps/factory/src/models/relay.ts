import { and, eq, sql as expression, gt, inArray, isNotNull, isNull, not } from "drizzle-orm";
import {
  type ModelConnectionReference,
  modelConnectionReference,
} from "../../../../packages/conversation-domain/src/model-connection";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  codingPause,
  runtimeAttempt,
} from "../../../../packages/db/src/schema";
import { runtimeModelToken } from "../../../../packages/runtime-domain/src/identity";
import { createAgentTurnStore } from "../agent/turns-api";
import { json } from "../http";
import { codingAllowanceDenial, codingBudgetIn } from "../usage/api";
import { createModelConnections } from "./connections";
import { ModelRequestError, readModelRequest } from "./request";
import { createOpenBaoModelSecrets } from "./secrets";

export function createModelRelay(
  database: ReturnType<typeof createDatabase>,
  secret: string,
  connection = {
    baseURL: process.env["FACTORY_MODEL_BASE_URL"],
    apiKey: process.env["FACTORY_MODEL_API_KEY"],
  },
  drainUsage?: (turnID: string, attemptID: string, sessionID: string) => Promise<void>,
) {
  const turns = createAgentTurnStore(database);
  const connections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    secret,
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [],
  );
  return async (request: Request, attemptID: string, suffix: string) => {
    if (
      request.method !== "POST" ||
      !["chat/completions", "responses", "messages"].includes(suffix)
    )
      return new Response("Not found", { status: 404 });
    const [runtime] = await database.db
      .select({ generation: runtimeAttempt.generation })
      .from(runtimeAttempt)
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          isNotNull(runtimeAttempt.changeId),
          eq(runtimeAttempt.state, "ready"),
        ),
      );
    if (
      !runtime ||
      (request.headers.get("authorization") !==
        `Bearer ${runtimeModelToken(secret, attemptID, Number(runtime.generation))}` &&
        request.headers.get("x-api-key") !==
          runtimeModelToken(secret, attemptID, Number(runtime.generation)))
    )
      return new Response("Unauthorized", { status: 401 });

    const [active] = await database.db
      .select({
        id: agentTurn.id,
        projectID: agentTurn.projectId,
        ownerToken: expression<string>`${agentTurn.ownerToken}`,
        modelId: expression<string>`${agentTurn.authority}->>'modelId'`,
        modelConnection: expression<ModelConnectionReference | null>`${agentTurn.authority}->'modelConnection'`,
        codingReasoning: expression<string | null>`${agentTurn.authority}->>'codingReasoning'`,
        sessionID: expression<string>`${changeAgentSession.opencodeSessionId}`,
      })
      .from(changeAgentSession)
      .innerJoin(agentTurn, eq(agentTurn.id, changeAgentSession.activeTurnId))
      .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
      .innerJoin(change, eq(change.id, changeAgentSession.changeId))
      .where(
        and(
          eq(changeAgentSession.runtimeAttemptId, attemptID),
          eq(changeAgentTurnIntent.runtimeAttemptId, attemptID),
          eq(agentTurn.changeId, changeAgentSession.changeId),
          eq(changeAgentTurnIntent.changeId, change.id),
          eq(change.runtimeAttemptId, attemptID),
          eq(changeAgentSession.opencodeSessionId, changeAgentTurnIntent.sessionId),
          not(changeAgentSession.stopPending),
          inArray(changeAgentSession.state, ["starting", "working"]),
          inArray(agentTurn.state, ["dispatching", "running"]),
          gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
          isNull(changeAgentTurnIntent.terminalOutcome),
        ),
      );
    if (!active) return json({ error: "No active Build authority for model inference" }, 403);
    let payload: Awaited<ReturnType<typeof readModelRequest>>;
    try {
      payload = await readModelRequest(request, active.codingReasoning);
    } catch (cause) {
      if (cause instanceof ModelRequestError) return json({ error: cause.message }, cause.status);
      return json({ error: "Model request is unavailable" }, 503);
    }
    try {
      if (payload.model !== active.modelId)
        return json({ error: "Model does not match the admitted Build" }, 403);
      const resolved = active.modelConnection
        ? await connections.resolve(
            modelConnectionReference.parse(active.modelConnection).connectionID,
            active.modelConnection.version,
          )
        : connection;
      const provider = "provider" in resolved ? resolved.provider : "openai";
      if (provider === "openai" && active.codingReasoning) {
        if (suffix !== "responses" || !payload.reasoningValid)
          return json({ error: "Coding reasoning does not match the admitted Build" }, 403);
      }
      if (
        (provider === "anthropic" && suffix !== "messages") ||
        (provider !== "anthropic" && suffix === "messages")
      )
        return json({ error: "Model transport does not match the admitted provider" }, 403);
      if (!resolved.baseURL || !resolved.apiKey)
        return json({ error: "Factory model relay is not configured" }, 503);
      const apiKey = resolved.apiKey;
      await drainUsage?.(active.id, attemptID, active.sessionID);
      let upstream: Promise<Response> | undefined;
      let paused = false;
      const allowed = await turns.validateExecution(active.id, active.ownerToken, async (sql) => {
        const db = drizzleTransaction(sql);
        const [current] = await db
          .select({ id: changeAgentSession.changeId })
          .from(changeAgentSession)
          .innerJoin(change, eq(change.id, changeAgentSession.changeId))
          .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
          .innerJoin(
            changeAgentTurnIntent,
            eq(changeAgentTurnIntent.turnId, changeAgentSession.activeTurnId),
          )
          .where(
            and(
              eq(changeAgentSession.activeTurnId, active.id),
              eq(changeAgentSession.runtimeAttemptId, attemptID),
              eq(change.runtimeAttemptId, attemptID),
              eq(runtimeAttempt.state, "ready"),
              eq(changeAgentTurnIntent.changeId, change.id),
              eq(changeAgentTurnIntent.runtimeAttemptId, attemptID),
              eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
              inArray(changeAgentSession.state, ["starting", "working"]),
              not(changeAgentSession.stopPending),
              isNull(changeAgentTurnIntent.terminalOutcome),
            ),
          );
        if (!current) return;
        const budget = await codingBudgetIn(sql, active.projectID, true);
        const hold = await db
          .select({ turnID: codingPause.turnId })
          .from(codingPause)
          .where(and(eq(codingPause.turnId, active.id), isNull(codingPause.resumedByTurnId)));
        if (!budget.allowed || hold.length) {
          paused = true;
          if (!hold.length) {
            const reason = budget.reason as typeof codingPause.$inferInsert.reason;
            await db
              .insert(codingPause)
              .values({ turnId: active.id, reason })
              .onConflictDoUpdate({
                target: codingPause.turnId,
                set: { reason, resumedByTurnId: null, createdAt: expression`now()` },
              });
          }
          return;
        }
        // Checkpoint and relay dispatch share the Turn lock. Advance the
        // observation epoch before dispatch so a stale native terminal read
        // cannot checkpoint over a request admitted during that observation.
        const started = performance.now();
        const [dispatch] = await db
          .update(changeAgentTurnIntent)
          .set({ modelRequestEpoch: expression`${changeAgentTurnIntent.modelRequestEpoch}+1` })
          .from(agentTurn)
          .where(
            and(
              eq(changeAgentTurnIntent.turnId, active.id),
              isNull(changeAgentTurnIntent.terminalOutcome),
              eq(agentTurn.id, changeAgentTurnIntent.turnId),
              eq(agentTurn.ownerToken, active.ownerToken),
              inArray(agentTurn.state, ["dispatching", "running"]),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .returning({
            leaseRemainingMS: expression<number>`EXTRACT(EPOCH FROM (${agentTurn.ownerExpiresAt}-clock_timestamp()))::float8*1000`,
          });
        if (!dispatch || performance.now() - started >= dispatch.leaseRemainingMS) return;
        upstream = fetch(`${resolved.baseURL?.replace(/\/$/, "")}/${suffix}`, {
          method: "POST",
          headers: {
            ...(provider === "anthropic"
              ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
              : { authorization: `Bearer ${apiKey}` }),
            "content-type": "application/json",
          },
          body: payload.body,
          signal: request.signal,
          redirect: "error",
        }).catch(() => json({ error: "Model provider is unavailable" }, 502));
        // Release authority locks after dispatch, never wait on provider streaming under them.
      });
      if (paused)
        return json(
          {
            error: codingAllowanceDenial,
          },
          403,
        );
      if (!allowed || !upstream)
        return json({ error: "Build authority changed before inference" }, 403);
      try {
        const response = await upstream;
        if (!response.ok) {
          await response.body?.cancel();
          return json(
            {
              error:
                response.status === 429
                  ? "Model provider rate limit reached"
                  : "Model provider rejected the request",
            },
            response.status,
          );
        }
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        });
      } catch {
        return json({ error: "Model provider is unavailable" }, 502);
      }
    } finally {
      await payload.dispose();
    }
  };
}
