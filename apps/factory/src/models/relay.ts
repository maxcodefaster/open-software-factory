import type { createDatabase } from "../../../../packages/db/src/client";
import { runtimeModelToken } from "../../../../packages/runtime-domain/src/identity";
import { createAgentTurnStore } from "../agent/turn-store";
import { json } from "../http";
import { createModelConnections } from "./connections";
import { createOpenBaoModelSecrets } from "./secrets";
import {
  modelConnectionReference,
  type ModelConnectionReference,
} from "../../../../packages/conversation-domain/src/model-connection";
import { codingBudgetIn } from "../usage/policy";
import { codingAllowanceDenial } from "../usage/opencode";

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
    const [runtime] = await database.client<Array<{ generation: string }>>`
      SELECT generation FROM factory.runtime_attempt
      WHERE id = ${attemptID} AND change_id IS NOT NULL AND state = 'ready'
    `;
    if (
      !runtime ||
      (request.headers.get("authorization") !==
        `Bearer ${runtimeModelToken(secret, attemptID, Number(runtime.generation))}` &&
        request.headers.get("x-api-key") !==
          runtimeModelToken(secret, attemptID, Number(runtime.generation)))
    )
      return new Response("Unauthorized", { status: 401 });

    const [active] = await database.client<
      Array<{
        id: string;
        ownerToken: string;
        modelId: string;
        modelConnection: ModelConnectionReference | null;
        sessionID: string;
        projectID: string;
      }>
    >`
      SELECT turn.id,turn.project_id AS "projectID", turn.owner_token AS "ownerToken", turn.authority->>'modelId' AS "modelId", turn.authority->'modelConnection' AS "modelConnection",session.opencode_session_id AS "sessionID"
      FROM factory.change_agent_session session
      JOIN factory.agent_turn turn ON turn.id = session.active_turn_id
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
      JOIN factory.change change ON change.id = session.change_id
      WHERE session.runtime_attempt_id = ${attemptID} AND intent.runtime_attempt_id = ${attemptID}
        AND turn.change_id = session.change_id AND intent.change_id = change.id
        AND change.runtime_attempt_id = ${attemptID} AND session.opencode_session_id = intent.session_id
        AND NOT session.stop_pending AND session.state IN ('starting', 'working')
        AND turn.state IN ('dispatching', 'running') AND turn.owner_expires_at > clock_timestamp()
    `;
    if (!active) return json({ error: "No active Build authority for model inference" }, 403);
    // Bound the decoded request too; Content-Length is only an early rejection.
    if (Number(request.headers.get("content-length")) > 4_194_304)
      return json({ error: "Model request is too large" }, 413);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Model request is required" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4_194_304) {
          await reader.cancel();
          return json({ error: "Model request is too large" }, 413);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return json({ error: "Invalid model request" }, 400);
    }
    if (!body || typeof body !== "object" || !("model" in body) || body.model !== active.modelId)
      return json({ error: "Model does not match the admitted Build" }, 403);
    const resolved = active.modelConnection
      ? await connections.resolve(
          modelConnectionReference.parse(active.modelConnection).connectionID,
          active.modelConnection.version,
        )
      : connection;
    const provider = "provider" in resolved ? resolved.provider : "openai";
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
      const [current] = await sql<Array<{ id: string }>>`
        SELECT session.change_id AS id FROM factory.change_agent_session session
        JOIN factory.change change ON change.id = session.change_id
        JOIN factory.runtime_attempt runtime ON runtime.id = session.runtime_attempt_id
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id = session.active_turn_id
        WHERE session.active_turn_id = ${active.id} AND session.runtime_attempt_id = ${attemptID}
          AND change.runtime_attempt_id = ${attemptID} AND runtime.state = 'ready'
          AND intent.change_id = change.id AND intent.runtime_attempt_id = ${attemptID}
          AND intent.session_id = session.opencode_session_id
          AND session.state IN ('starting', 'working') AND NOT session.stop_pending
      `;
      if (!current) return;
      const budget = await codingBudgetIn(sql, active.projectID, true);
      const hold =
        await sql`SELECT turn_id FROM factory.coding_pause WHERE turn_id=${active.id} AND resumed_by_turn_id IS NULL`;
      if (!budget.allowed || hold.length) {
        paused = true;
        if (!hold.length)
          await sql`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${active.id},${budget.reason})
            ON CONFLICT(turn_id) DO UPDATE SET reason=EXCLUDED.reason,resumed_by_turn_id=NULL,created_at=now()`;
        return;
      }
      upstream = fetch(`${resolved.baseURL?.replace(/\/$/, "")}/${suffix}`, {
        method: "POST",
        headers: {
          ...(provider === "anthropic"
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${apiKey}` }),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
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
  };
}
