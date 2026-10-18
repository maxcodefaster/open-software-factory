import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import {
  runtimeBuildBrowserToken,
  runtimeModelToken,
} from "../../packages/runtime-domain/src/identity";
import { createBuildBrowserController } from "../../apps/factory/src/agent/browser-controller";
import { createBuildBrowserEndpoint } from "../../apps/factory/src/agent/browser-endpoint";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { observe } from "../fixtures/pinned-opencode";
import { RuntimeParentOperationError, type RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

let installation: Awaited<ReturnType<typeof factoryProcess>>;
beforeAll(async () => {
  installation = await factoryProcess();
}, 30_000);
afterAll(async () => {
  await installation.dispose();
}, 30_000);

async function setup() {
  const owned = await fixture(undefined, undefined, installation.connect());
  const admission = createChangeAdmission(owned.database, buildModelID);
  const { turn } = await admission.admit(owned.changeID, owned.userID, {
    kind: "change-prompt",
    commandId: crypto.randomUUID(),
    text: "Inspect the declared App",
  });
  const turns = createAgentTurnStore(owned.database);
  const claimed = await turns.claimPending(turn.id);
  if (!claimed?.ownerToken) throw new Error("Owned browser test lease required");
  const ownerToken = claimed.ownerToken;
  await owned.database.client`UPDATE factory.change_agent_turn_intent
    SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${turn.id}`;
  await owned.database.client`UPDATE factory.change_agent_session
    SET state = 'starting', active_turn_id = ${turn.id} WHERE change_id = ${owned.changeID}`;
  expect(await turns.beginDispatch(turn.id, ownerToken)).not.toBeNull();
  const frames: Parameters<RuntimeHub["parentOperation"]>[1][] = [];
  owned.hub.parentOperation = async (_attempt, payload, beforeSend) => {
    let sent = !beforeSend;
    await beforeSend?.(() => {
      sent = true;
      frames.push(payload);
    });
    if (!beforeSend) frames.push(payload);
    if (!sent) throw new Error("Browser frame was not admitted");
    const data = JSON.parse(String(payload["data"])) as { sessionId: string; expiresAt: string };
    const [intent] = await owned.database.client<Array<{ state: string }>>`
      SELECT state FROM factory.build_browser_session WHERE id = ${data.sessionId}`;
    expect(intent).toBeDefined();
    if (payload.action === "browser-close") {
      expect(intent?.state).toBe("closing");
      return {};
    }
    expect(Date.parse(data.expiresAt) - Date.now()).toBeGreaterThan(1_000);
    expect(Date.parse(data.expiresAt) - Date.now()).toBeLessThanOrEqual(25_000);
    expect(payload["generation"]).toBe(1);
    expect(payload["runtimeAttemptId"]).toBe(owned.attemptID);
    return {
      data: JSON.stringify({
        content: [{ type: "text", text: "Declared App inspection" }],
        structuredContent: {
          sessionId: data.sessionId,
          turnId: turn.id,
          runtimeAttemptId: owned.attemptID,
          generation: 1,
          app: "app",
          headCommit: "a".repeat(40),
          workingTreeModified: false,
          observedAt: new Date().toISOString(),
        },
      }),
    };
  };
  const browser = createBuildBrowserController(
    owned.database,
    owned.hub,
    "owned-browser-fixture-secret",
  );
  const grant = await browser.prepare(turn.id, ownerToken);
  const authorization = `Bearer ${grant.bearer}`;
  const authorized = await browser.authorize(grant.sessionID, authorization);
  if (!authorized) throw new Error("Owned browser grant unavailable");
  return {
    owned,
    turn,
    ownerToken,
    browser,
    grant,
    authorization,
    authorized,
    frames,
    endpoint: createBuildBrowserEndpoint(browser),
    async dispose() {
      await browser.closeTurn(turn.id);
      await owned.dispose();
    },
  };
}

test("browser create intent is immutable, deterministic and persisted before exact dispatch", async () => {
  const scope = await setup();
  try {
    const { browser, turn, ownerToken, owned, authorized } = scope;
    expect(await browser.prepare(turn.id, ownerToken)).toEqual(scope.grant);
    expect(scope.frames).toHaveLength(0);
    await expect(
      owned.database.client`UPDATE factory.build_browser_session SET owner_id = ${"f".repeat(64)}
      WHERE id = ${scope.grant.sessionID}`.execute(),
    ).rejects.toThrow("immutable");
    await expect(
      owned.database.client`UPDATE factory.build_browser_session SET generation = 2
      WHERE id = ${scope.grant.sessionID}`.execute(),
    ).rejects.toThrow("immutable");
    const result = await browser.call(
      authorized.session,
      ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      1,
    );
    expect(result.content[0]).toEqual({ type: "text", text: "Declared App inspection" });
    expect(scope.frames).toHaveLength(1);
    const [state] = await owned.database.client<Array<{ state: string; confirmed: boolean }>>`
      SELECT state, create_confirmed_at IS NOT NULL AS confirmed
      FROM factory.build_browser_session WHERE id = ${scope.grant.sessionID}`;
    expect(state).toEqual({ state: "active", confirmed: true });
    await browser.closeTurn(turn.id);
    expect(await browser.authorize(scope.grant.sessionID, scope.authorization)).toBeNull();
    await expect(browser.prepare(turn.id, ownerToken)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      owned.database.client`UPDATE factory.build_browser_session SET outcome_summary = 'changed'
      WHERE id = ${scope.grant.sessionID}`.execute(),
    ).rejects.toThrow("immutable");
  } finally {
    await scope.dispose();
  }
});

test("runtime browser capability cannot use another turn, generation, Project or relay authority", async () => {
  const scope = await setup();
  const secret = "owned-browser-fixture-secret";
  const token = `Bearer ${runtimeBuildBrowserToken(secret, scope.owned.attemptID, 1)}`;
  try {
    expect(
      await scope.browser.authorizeRuntime(scope.owned.attemptID, scope.turn.id, token),
    ).not.toBeNull();
    expect(
      await scope.browser.authorizeRuntime(scope.owned.attemptID, crypto.randomUUID(), token),
    ).toBeNull();
    expect(
      await scope.browser.authorizeRuntime(crypto.randomUUID(), scope.turn.id, token),
    ).toBeNull();
    expect(
      await scope.browser.authorizeRuntime(
        scope.owned.attemptID,
        scope.turn.id,
        `Bearer ${runtimeBuildBrowserToken(secret, scope.owned.attemptID, 2)}`,
      ),
    ).toBeNull();
    expect(
      await scope.browser.authorizeRuntime(
        scope.owned.attemptID,
        scope.turn.id,
        `Bearer ${runtimeModelToken(secret, scope.owned.attemptID, 1)}`,
      ),
    ).toBeNull();
    await scope.owned.database
      .client`DELETE FROM factory.project_membership WHERE project_id = ${scope.owned.projectID} AND user_id = ${scope.owned.userID}`;
    expect(
      await scope.browser.authorizeRuntime(scope.owned.attemptID, scope.turn.id, token),
    ).toBeNull();
    expect(scope.frames).toHaveLength(0);
  } finally {
    await scope.dispose();
  }
});

test("one browser_open waits for confirmed cold preparation without another model turn", async () => {
  const scope = await setup();
  const forward = scope.owned.hub.parentOperation.bind(scope.owned.hub);
  let preparing = true;
  try {
    scope.owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
      if (preparing && payload.action === "browser-call") {
        await beforeSend?.(() => scope.frames.push(payload));
        preparing = false;
        throw new RuntimeParentOperationError(
          "browser-call",
          "Browser tools are preparing; retry browser inspection after preparation completes",
        );
      }
      return forward(attempt, payload, beforeSend);
    };
    const result = await scope.browser.call(
      scope.authorized.session,
      scope.ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      "cold-open",
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.turnId).toBe(scope.turn.id);
    expect(scope.frames.map(({ action }) => action)).toEqual(["browser-call", "browser-call"]);
    expect(
      await scope.browser.authorize(scope.grant.sessionID, scope.authorization),
    ).not.toBeNull();
    const [state] = await scope.owned.database.client<Array<{ state: string }>>`
      SELECT state FROM factory.build_browser_session WHERE id=${scope.grant.sessionID}`;
    expect(state?.state).toBe("active");
  } finally {
    await scope.dispose();
  }
});

test("the current Build renews intended browser authority before its first observation", async () => {
  const scope = await setup();
  try {
    await scope.browser.renewTurn(scope.turn.id, scope.ownerToken);
    expect(scope.frames.map(({ action }) => action)).toEqual(["browser-renew"]);
    const [state] = await scope.owned.database.client<Array<{ state: string; confirmed: boolean }>>`
      SELECT state, create_confirmed_at IS NOT NULL AS confirmed FROM factory.build_browser_session
      WHERE id = ${scope.grant.sessionID}`;
    expect(state).toEqual({ state: "intended", confirmed: false });
    expect(
      await scope.browser.authorize(scope.grant.sessionID, scope.authorization),
    ).not.toBeNull();
  } finally {
    await scope.dispose();
  }
});

test.each(["Stop", "caller disconnect", "lost response"] as const)(
  "cold browser preparation cannot replay after %s",
  async (boundary) => {
    const scope = await setup();
    const abort = new AbortController();
    const forward = scope.owned.hub.parentOperation.bind(scope.owned.hub);
    let calls = 0;
    try {
      scope.owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
        if (payload.action !== "browser-call") return forward(attempt, payload, beforeSend);
        await beforeSend?.(() => {
          calls++;
          scope.frames.push(payload);
        });
        if (boundary === "lost response") throw new Error("Owned response was lost");
        if (boundary === "caller disconnect") abort.abort();
        else {
          await createChangeAgentStop(scope.owned.database, scope.owned.hub).persist(
            scope.owned.changeID,
          );
        }
        throw new RuntimeParentOperationError(
          "browser-call",
          "Browser tools are preparing; retry browser inspection after preparation completes",
        );
      };
      await expect(
        scope.browser.call(
          scope.authorized.session,
          scope.ownerToken,
          { name: "browser_open", arguments: { app: "app" } },
          `cold-${boundary}`,
          abort.signal,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(calls).toBe(1);
      const [session] = await scope.owned.database.client<Array<{ state: string }>>`
        SELECT state FROM factory.build_browser_session WHERE id=${scope.grant.sessionID}`;
      expect(session?.state).toBe("closed");
    } finally {
      await scope.dispose();
    }
  },
);

test("a confirmed element interaction failure requires a fresh snapshot, not a new Build", async () => {
  const scope = await setup();
  const forward = scope.owned.hub.parentOperation.bind(scope.owned.hub);
  const fill = { name: "browser_fill", arguments: { uid: "2_0", value: "Owned fixture" } };
  try {
    await scope.browser.call(
      scope.authorized.session,
      scope.ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      "open",
    );
    const active = await scope.browser.authorize(scope.grant.sessionID, scope.authorization);
    if (!active) throw new Error("Active fixture browser missing");
    let failFill = true;
    scope.owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
      const output = await forward(attempt, payload, beforeSend);
      if (failFill && payload.action === "browser-call") {
        failFill = false;
        return {
          data: JSON.stringify({
            isError: true,
            content: [{ type: "text", text: "Element did not become interactive." }],
          }),
        };
      }
      return output;
    };
    expect(
      (await scope.browser.call(active.session, scope.ownerToken, fill, "failed-fill")).isError,
    ).toBe(true);
    expect(
      await scope.browser.authorize(scope.grant.sessionID, scope.authorization),
    ).not.toBeNull();
    await expect(
      scope.browser.call(active.session, scope.ownerToken, fill, "blocked-repeat"),
    ).rejects.toThrow("fresh browser_snapshot");
    expect(scope.frames.map(({ action }) => action)).toEqual(["browser-call", "browser-call"]);
    await scope.browser.call(
      active.session,
      scope.ownerToken,
      { name: "browser_snapshot", arguments: {} },
      "observe",
    );
    await scope.browser.call(active.session, scope.ownerToken, fill, "new-action");
    expect(scope.frames.map(({ action }) => action)).toEqual([
      "browser-call",
      "browser-call",
      "browser-call",
      "browser-call",
    ]);
  } finally {
    await scope.dispose();
  }
});

test.each(["missing", "session", "turn", "runtime", "generation", "commit"] as const)(
  "browser rejects %s observation provenance and closes the exact session",
  async (boundary) => {
    const scope = await setup();
    const forward = scope.owned.hub.parentOperation.bind(scope.owned.hub);
    try {
      scope.owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
        const output = await forward(attempt, payload, beforeSend);
        if (payload.action !== "browser-call") return output;
        const result = JSON.parse(output.data ?? "") as {
          structuredContent?: Record<string, unknown>;
        };
        if (boundary === "missing") delete result.structuredContent;
        else {
          const key = {
            session: "sessionId",
            turn: "turnId",
            runtime: "runtimeAttemptId",
            generation: "generation",
            commit: "headCommit",
          }[boundary];
          if (!result.structuredContent) throw new Error("Fixture provenance required");
          result.structuredContent[key] =
            boundary === "generation"
              ? 2
              : boundary === "commit"
                ? "not-a-commit"
                : crypto.randomUUID();
        }
        return { ...output, data: JSON.stringify(result) };
      };
      await expect(
        scope.browser.call(
          scope.authorized.session,
          scope.ownerToken,
          { name: "browser_open", arguments: { app: "app" } },
          1,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(scope.frames.map(({ action }) => action)).toEqual(["browser-call", "browser-close"]);
      const [session] = await scope.owned.database.client<
        Array<{
          state: string;
          context: unknown;
          confirmed: boolean;
        }>
      >`SELECT state, inspection_context AS context, create_confirmed_at IS NOT NULL AS confirmed
        FROM factory.build_browser_session WHERE id = ${scope.grant.sessionID}`;
      expect(session).toEqual({ state: "closed", context: null, confirmed: false });
    } finally {
      await scope.dispose();
    }
  },
);

test("compact exact checkout context survives cleanup; missing or foreign SQL context is rejected", async () => {
  const scope = await setup();
  try {
    const result = await scope.browser.call(
      scope.authorized.session,
      scope.ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      1,
    );
    expect(result.structuredContent).toMatchObject({ changeId: scope.owned.changeID });
    for (const invalid of [{}, { ...result.structuredContent, turnId: crypto.randomUUID() }]) {
      await expect(
        scope.owned.database.client`UPDATE factory.build_browser_session
        SET inspection_context = ${JSON.stringify(invalid)}::jsonb
        WHERE id = ${scope.grant.sessionID}`.execute(),
      ).rejects.toThrow("check constraint");
    }
    await scope.browser.closeTurn(scope.turn.id);
    const [retained] = await scope.owned.database.client<
      Array<{ state: string; context: unknown; bytes: number }>
    >`
      SELECT state, inspection_context AS context, octet_length(inspection_context::text) AS bytes
      FROM factory.build_browser_session WHERE id = ${scope.grant.sessionID}`;
    expect(retained?.state).toBe("closed");
    expect(retained?.context).toEqual(result.structuredContent);
    expect(retained?.bytes).toBeLessThan(2048);
    expect(JSON.stringify(retained?.context)).not.toContain("Declared App inspection");
  } finally {
    await scope.dispose();
  }
});

test("a complete JSON prefix without body EOF cannot dispatch after the input deadline", async () => {
  const scope = await setup();
  try {
    const response = await scope.endpoint(
      new Request("http://factory.test/internal/browser", {
        method: "POST",
        headers: { authorization: scope.authorization, "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: { name: "browser_snapshot", arguments: {} },
                }),
              ),
            );
          },
        }),
      }),
      scope.grant.sessionID,
    );
    expect(response.status).toBe(400);
    expect(scope.frames).toHaveLength(0);
  } finally {
    await scope.dispose();
  }
});

test.each(["Stop", "completion"] as const)(
  "Build lifecycle prepares before prompt and closes its browser on %s",
  async (outcome) => {
    const owned = await fixture(undefined, undefined, installation.connect());
    const browser = createBuildBrowserController(
      owned.database,
      owned.hub,
      "owned-browser-lifecycle-secret",
    );
    const frames: string[] = [];
    const originalOperation = owned.hub.parentOperation.bind(owned.hub);
    owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
      if (payload.action !== "browser-close")
        return originalOperation(attempt, payload, beforeSend);
      const scope = JSON.parse(String(payload["data"])) as { turnId: string };
      const [session] = await owned.database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.build_browser_session WHERE turn_id = ${scope.turnId}`;
      expect(session?.state).toBe("closing");
      frames.push(payload.action);
      return {};
    };
    const controller = createAgentController(
      owned.database,
      owned.hub,
      { startPersisted: async () => null },
      browser,
      owned.writers,
    );
    owned.acceptResponse();
    try {
      const commandID = crypto.randomUUID();
      await controller.prompt(owned.changeID, "Use only the declared App", owned.userID, commandID);
      await owned.requested;
      const turn = await owned.turn(commandID);
      if (!turn) throw new Error("Owned lifecycle turn required");
      const [prepared] = await owned.database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.build_browser_session WHERE turn_id = ${turn.id}`;
      expect(prepared?.state).toBe("intended");
      const intent = await createChangeAdmission(owned.database, buildModelID).intent(turn.id);
      expect(intent.text).toContain(`browser-client ${turn.id}`);
      if (outcome === "Stop") await controller.stop(owned.changeID);
      else owned.finish();
      owned.release();
      await observe(
        async () =>
          (
            await owned.database.client<
              Array<{ state: string }>
            >`SELECT state FROM factory.build_browser_session WHERE turn_id = ${turn.id}`
          )[0]?.state,
        (state) => state === "closed",
      );
      expect(frames).toEqual(["browser-close"]);
      expect(
        await browser.authorizeRuntime(
          owned.attemptID,
          turn.id,
          `Bearer ${runtimeBuildBrowserToken("owned-browser-lifecycle-secret", owned.attemptID, 1)}`,
        ),
      ).toBeNull();
    } finally {
      owned.release();
      await controller.shutdown();
      await owned.dispose();
    }
  },
  15_000,
);

test("Build heartbeat renews browser authority while native history observation is stalled", async () => {
  const owned = await fixture(undefined, undefined, installation.connect());
  const browser = createBuildBrowserController(owned.database, owned.hub, "owned-stalled-history");
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let renewals = 0;
  const request = owned.hub.request.bind(owned.hub);
  const operation = owned.hub.parentOperation.bind(owned.hub);
  owned.hub.request = async (...args) => {
    if (new URL(args[2].url).pathname.endsWith("/log")) {
      const [turn] = await owned.database.client<Array<{ state: string }>>`
        SELECT state FROM factory.agent_turn WHERE change_id=${owned.changeID} ORDER BY created_at DESC LIMIT 1`;
      if (turn?.state === "running") {
        blocked.resolve();
        await release.promise;
      }
    }
    return request(...args);
  };
  owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
    if (payload.action === "browser-renew" || payload.action === "browser-close") {
      await beforeSend?.(() => {});
      if (payload.action === "browser-renew") renewals++;
      return {};
    }
    return operation(attempt, payload, beforeSend);
  };
  const controller = createAgentController(
    owned.database,
    owned.hub,
    { startPersisted: async () => null },
    browser,
    owned.writers,
  );
  owned.acceptResponse();
  try {
    await controller.prompt(
      owned.changeID,
      "Inspect the declared App",
      owned.userID,
      crypto.randomUUID(),
    );
    await owned.requested;
    owned.release();
    await blocked.promise;
    const before = renewals;
    await observe(
      () => Promise.resolve(renewals),
      (count) => count > before,
      "Browser authority was not renewed while native history was stalled",
      12_000,
    );
    expect(owned.requests()).toBe(1);
  } finally {
    release.resolve();
    owned.release();
    await controller.stop(owned.changeID);
    await controller.shutdown();
    await owned.dispose();
  }
}, 20_000);

test("browser facade denies human origins, arbitrary MCP, raw URLs, oversized chunks and duplicate mutations", async () => {
  const scope = await setup();
  try {
    const rpc = (method: string, params?: unknown, headers: Record<string, string> = {}, id = 1) =>
      scope.endpoint(
        new Request("http://factory.test/internal/browser/mcp", {
          method: "POST",
          headers: {
            authorization: scope.authorization,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            ...(params !== undefined ? { params } : {}),
          }),
        }),
        scope.grant.sessionID,
      );
    expect((await rpc("tools/list", undefined, { origin: "http://factory.test" })).status).toBe(
      403,
    );
    expect((await rpc("tools/list", undefined, { authorization: "Bearer invalid" })).status).toBe(
      403,
    );
    expect(
      await scope.browser.authorize(scope.grant.sessionID, `Bearer ${"é".repeat(64)}`),
    ).toBeNull();
    const catalogue = (await (await rpc("tools/list")).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(catalogue.result.tools).toHaveLength(7);
    expect(catalogue.result.tools.map(({ name }) => name)).not.toContain("evaluate_script");
    const registered = (await (await rpc("resources/list")).json()) as { error: { code: number } };
    expect(registered.error.code).toBe(-32601);
    const arbitrary = (await (
      await rpc("tools/call", {
        name: "browser_open",
        arguments: { url: "http://169.254.169.254" },
      })
    ).json()) as { error: { code: number } };
    expect(arbitrary.error.code).toBe(-32602);
    expect(scope.frames).toHaveLength(0);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(16_385)));
        controller.close();
      },
    });
    const oversized = await scope.endpoint(
      new Request("http://factory.test/internal/browser/mcp", {
        method: "POST",
        headers: { authorization: scope.authorization, "content-type": "application/json" },
        body,
      }),
      scope.grant.sessionID,
    );
    expect(oversized.status).toBe(400);
    await rpc("tools/call", { name: "browser_open", arguments: { app: "app" } });
    const repeated = (await (
      await rpc("tools/call", { name: "browser_open", arguments: { app: "app" } })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(repeated.result.isError).toBe(true);
    expect(repeated.result.content[0]?.text).toContain("already dispatched");
    expect(scope.frames).toHaveLength(1);
  } finally {
    await scope.dispose();
  }
});

test.each(["Stop", "Requirements", "generation", "Session", "membership", "owner"] as const)(
  "browser calls reject changed %s authority at the exact frame send",
  async (boundary) => {
    const scope = await setup();
    try {
      const { owned } = scope;
      const forward = owned.hub.parentOperation.bind(owned.hub);
      owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
        if (payload.action === "browser-call") {
          if (boundary === "Stop")
            await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
          if (boundary === "Requirements") {
            const content = canonicalRequirementContent({
              summary: "Unapproved next revision",
              acceptanceCriteria: ["Needs a new exact approval"],
              nonGoals: [],
            });
            await owned.database
              .client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal,
              canonical_content, content_digest, created_by) VALUES (${crypto.randomUUID()}, ${owned.ticketID}, 2,
              ${content}, ${createHash("sha256").update(content).digest("hex")}, ${owned.userID})`;
          }
          if (boundary === "generation")
            await owned.database.client`UPDATE factory.change
            SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
          if (boundary === "Session")
            await owned.database.client`UPDATE factory.change_agent_session
            SET opencode_session_id = 'ses_replaced' WHERE change_id = ${owned.changeID}`;
          if (boundary === "membership")
            await owned.database.client`DELETE FROM factory.project_membership
            WHERE project_id = ${owned.projectID} AND user_id = ${owned.userID}`;
          if (boundary === "owner")
            await owned.database.client`UPDATE factory.agent_turn
            SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${scope.turn.id}`;
        }
        return forward(attempt, payload, beforeSend);
      };
      await expect(
        scope.browser.call(
          scope.authorized.session,
          scope.ownerToken,
          { name: "browser_open", arguments: { app: "app" } },
          1,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(scope.frames.map((frame) => frame.action)).toEqual(["browser-close"]);
      expect(await scope.browser.authorize(scope.grant.sessionID, scope.authorization)).toBeNull();
    } finally {
      await scope.dispose();
    }
  },
);

test("lost browser response is not replayed and cleanup remains unconfirmed until exact recovery", async () => {
  const scope = await setup();
  try {
    const forward = scope.owned.hub.parentOperation.bind(scope.owned.hub);
    scope.owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
      await forward(attempt, payload, beforeSend);
      throw new Error("Injected lost browser outcome");
    };
    await expect(
      scope.browser.call(
        scope.authorized.session,
        scope.ownerToken,
        { name: "browser_open", arguments: { app: "app" } },
        1,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const [closing] = await scope.owned.database.client<
      Array<{ state: string; confirmed: boolean }>
    >`
      SELECT state, cleanup_confirmed_at IS NOT NULL AS confirmed
      FROM factory.build_browser_session WHERE id = ${scope.grant.sessionID}`;
    expect(closing).toEqual({ state: "closing", confirmed: false });
    scope.owned.hub.parentOperation = forward;
    await scope.browser.recover(scope.owned.attemptID);
    expect(scope.frames.map(({ action }) => action)).toEqual([
      "browser-call",
      "browser-close",
      "browser-close",
    ]);
    const [closed] = await scope.owned.database.client<
      Array<{ state: string; confirmed: boolean }>
    >`
      SELECT state, cleanup_confirmed_at IS NOT NULL AS confirmed
      FROM factory.build_browser_session WHERE id = ${scope.grant.sessionID}`;
    expect(closed).toEqual({ state: "closed", confirmed: true });
  } finally {
    await scope.dispose();
  }
});

for (const failure of [
  "browser container did not retain its exact isolation boundary",
  "browser App proxy did not become ready within five seconds",
  "Unexpected registry credential: owned-secret-do-not-publish",
  "browser App is not declared in this Workspace",
]) {
  test(`browser failure is actionable without forwarding raw diagnostics: ${failure.split(":")[0]}`, async () => {
    const scope = await setup();
    try {
      const forward = scope.owned.hub.parentOperation.bind(scope.owned.hub);
      scope.owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
        if (payload.action === "browser-call") throw new Error(failure);
        return forward(attempt, payload, beforeSend);
      };
      const response = await scope.endpoint(
        new Request("http://factory.invalid/browser", {
          method: "POST",
          headers: { authorization: scope.authorization, "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "browser_open", arguments: { app: "app" } },
          }),
        }),
        scope.grant.sessionID,
      );
      const body = await response.text();
      expect(body).toContain("Do not replay a UI mutation");
      expect(body).not.toContain("owned-secret-do-not-publish");
      if (failure.startsWith("browser")) expect(body).toContain(failure);
      const [closed] = await scope.owned.database.client<
        Array<{ state: string; confirmed: boolean }>
      >`
        SELECT state, cleanup_confirmed_at IS NOT NULL AS confirmed FROM factory.build_browser_session WHERE id = ${scope.grant.sessionID}`;
      expect(closed).toEqual({ state: "closed", confirmed: true });
    } finally {
      await scope.dispose();
    }
  });
}

test("failed App inspection returns bounded error text without claiming successful provenance", async () => {
  const scope = await setup();
  try {
    const forward = scope.owned.hub.parentOperation.bind(scope.owned.hub);
    scope.owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
      const result = await forward(attempt, payload, beforeSend);
      return payload.action === "browser-call"
        ? {
            data: JSON.stringify({
              isError: true,
              content: [{ type: "text", text: "Declared App navigation exceeded its deadline" }],
            }),
          }
        : result;
    };
    const result = await scope.browser.call(
      scope.authorized.session,
      scope.ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      1,
    );
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Declared App navigation exceeded its deadline" }],
    });
    const [closed] = await scope.owned.database.client<
      Array<{ state: string; context: unknown; created: boolean; cleaned: boolean }>
    >`
      SELECT state, inspection_context AS context, create_confirmed_at IS NOT NULL AS created, cleanup_confirmed_at IS NOT NULL AS cleaned
      FROM factory.build_browser_session WHERE id = ${scope.grant.sessionID}`;
    expect(closed).toEqual({ state: "closed", context: null, created: false, cleaned: true });
  } finally {
    await scope.dispose();
  }
});
