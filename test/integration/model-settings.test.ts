import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createModelSettingsController } from "../../apps/factory/src/models/controller";
import { createModelRelay } from "../../apps/factory/src/models/relay";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { modelSettingsView } from "../../packages/conversation-domain/src/model-settings";
import { runtimeModelToken } from "../../packages/runtime-domain/src/identity";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

const planning = "planning-original";
const build = "build-original";
const alternative = "approved-alternative";
const models = [planning, build, alternative];
const environment = {
  planningModelId: planning,
  buildModelId: build,
  models,
  baseURL: undefined,
  apiKey: undefined,
};
const administrator = "01994a7d-0000-7000-8000-000000000001";

test("administrator commands enforce auth, origin, catalogue and CAS and survive restart", async () => {
  const process = await factoryProcess(undefined, {
    FACTORY_PROJECT_AGENT_MODEL: planning,
    FACTORY_AGENT_MODEL_ID: build,
    FACTORY_MODEL_IDS: models.join(","),
  });
  try {
    const first = await process.start();
    const cookie = await process.signIn();
    const headers = { cookie, origin: process.base, "content-type": "application/json" };
    const url = `${process.base}/api/model-settings`;
    expect((await fetch(url)).status).toBe(401);
    const database = process.connect();
    const outsider = crypto.randomUUID();
    const outsiderEmail = `nonadmin-${outsider}@factory.local`;
    try {
      await database.client`INSERT INTO auth."user"(id, name, email, email_verified)
        VALUES (${outsider}, 'Nonadministrator', ${outsiderEmail}, true)`;
      await database.client`INSERT INTO auth.account(id, account_id, provider_id, user_id, password)
        SELECT ${crypto.randomUUID()}, ${outsider}, 'credential', ${outsider}, password
        FROM auth.account WHERE user_id = ${administrator} AND provider_id = 'credential'`;
      const login = await fetch(`${process.base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: process.base, "content-type": "application/json" },
        body: JSON.stringify({
          email: outsiderEmail,
          password: "owned-process-password-not-a-secret",
        }),
      });
      expect(login.status).toBe(200);
      const outsiderCookie = login.headers
        .getSetCookie()
        .map((item) => item.split(";")[0])
        .join("; ");
      expect((await fetch(url, { headers: { cookie: outsiderCookie } })).status).toBe(403);
    } finally {
      await database.client.end();
    }
    const initial = modelSettingsView.parse(await (await fetch(url, { headers })).json());
    expect(initial.version).toBe(0);
    expect(initial.source).toBe("environment");
    expect(initial.planningModelId).toBe(planning);
    expect(initial.buildModelId).toBe(build);
    expect(initial.rules.build.reasoningEffort).toBe("medium");
    expect(JSON.stringify(initial)).not.toContain("owned-unused-model-token");
    const body = {
      version: 0,
      planningModelId: alternative,
      buildModelId: alternative,
      rules: {
        ...initial.rules,
        build: { ...initial.rules.build, reasoningEffort: "high" },
      },
    };
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            ...body,
            rules: { ...body.rules, build: { ...body.rules.build, reasoningEffort: "none" } },
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers, origin: "https://other.invalid" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...body, buildModelId: "unapproved" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...body, apiKey: "not-allowed" }),
        })
      ).status,
    ).toBe(400);
    const concurrent = await Promise.all(
      [1, 2].map(() => fetch(url, { method: "PUT", headers, body: JSON.stringify(body) })),
    );
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const saved = modelSettingsView.parse(await (await fetch(url, { headers })).json());
    expect(saved.version).toBe(1);
    expect(saved.source).toBe("administrator");
    expect(saved.rules.build.reasoningEffort).toBe("high");
    await process.kill(first);
    await process.start();
    expect(modelSettingsView.parse(await (await fetch(url, { headers })).json())).toEqual(saved);
    expect(await (await fetch(`${url}/check`, { method: "POST", headers })).json()).toEqual({
      status: "unavailable",
    });
  } finally {
    await process.dispose();
  }
}, 60_000);

test("admission freezes models across changed defaults and command replay", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  let owned: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await process.start();
    owned = await fixture(undefined, undefined, database);
    const settings = createModelSettingsController(database, environment);
    const admission = createChangeAdmission(database, (sql, context) =>
      settings.resolve("build", sql, context),
    );
    const commandId = crypto.randomUUID();
    const first = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId,
    });
    expect(first.turn.authority.modelId).toBe(build);
    expect(first.turn.authority).toMatchObject({ codingReasoning: "medium" });
    const firstIntent = await admission.intent(first.turn.id);
    expect(firstIntent.text).toContain("Factory Build goal v1:");
    expect(firstIntent.text).not.toContain("factory-build-result");
    const turns = createAgentTurnStore(database);
    const owner = await turns.claimPending(first.turn.id);
    if (!owner?.ownerToken) throw new Error("Owned turn was not claimed");
    await turns.failPending(owner.id, owner.ownerToken, "Owned admission only");
    await settings.set(
      {
        version: 0,
        planningModelId: alternative,
        buildModelId: alternative,
        rules: {
          planning: { models, allowOverride: true },
          build: { models, allowOverride: true, reasoningEffort: "high" },
        },
      },
      administrator,
    );
    const another = await fixture(undefined, undefined, process.connect());
    try {
      const start = await createChangeAdmission(another.database, (sql, context) =>
        settings.resolve("build", sql, context),
      ).admit(another.changeID, another.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
        codingReasoning: "max",
      });
      expect(start.turn.authority.modelId).toBe(alternative);
      expect(start.turn.authority).toMatchObject({ codingReasoning: "max" });
      expect(start.turn.command).toMatchObject({ codingReasoning: "max" });
      await expect(
        createChangeAdmission(another.database, alternative).admit(
          another.changeID,
          another.userID,
          {
            kind: "change-start",
            commandId: start.turn.command.commandId,
            codingReasoning: "medium",
          },
        ),
      ).rejects.toThrow("different input");
      const secondTurns = createAgentTurnStore(another.database);
      const claimed = await secondTurns.claimPending(start.turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned new Change was not claimed");
      await secondTurns.failPending(claimed.id, claimed.ownerToken, "Owned model admission");
      await expect(
        createChangeAdmission(another.database, alternative).admit(
          another.changeID,
          another.userID,
          {
            kind: "change-start",
            commandId: crypto.randomUUID(),
            codingReasoning: "medium",
          },
        ),
      ).rejects.toThrow("original reasoning");
    } finally {
      await another.dispose();
    }
    const withdrawn = createModelSettingsController(database, {
      ...environment,
      models: [planning, build],
    });
    await expect(
      database.client.begin((sql) =>
        withdrawn.resolve("build", sql, {
          projectID: owned?.projectID ?? "",
          userID: owned?.userID ?? "",
        }),
      ),
    ).rejects.toThrow("no longer approved");
    const replay = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId,
    });
    expect(replay.turn.id).toBe(first.turn.id);
    expect(replay.turn.authority.modelId).toBe(build);
    expect(replay.turn.authority).toMatchObject({ codingReasoning: "medium" });
    const next = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Continue",
    });
    expect(next.turn.authority.modelId).toBe(build);
    expect(next.turn.authority).toMatchObject({ codingReasoning: "medium" });
    const nextOwner = await turns.claimPending(next.turn.id);
    if (!nextOwner?.ownerToken) throw new Error("Owned next turn was not claimed");
    await turns.failPending(nextOwner.id, nextOwner.ownerToken, "Owned admission only");
    const restorePlanning = processEnv("FACTORY_PROJECT_AGENT_MODEL", planning);
    const restoreCatalogue = processEnv("FACTORY_MODEL_IDS", models.join(","));
    const restoreProvider = processEnv("FACTORY_MODEL_BASE_URL", "http://127.0.0.1:9/v1");
    try {
      const project = createProjectAgentController(database, { start: async () => null });
      const id = crypto.randomUUID();
      await project
        .message(owned.projectID, undefined, "Investigate only", owned.userID, id)
        .catch(() => {});
      const record = await turns.getByCommand(id);
      expect(record?.authority.modelId).toBe(alternative);
      await settings.set(
        { version: 1, planningModelId: planning, buildModelId: build },
        administrator,
      );
      expect((await turns.getByCommand(id))?.authority.modelId).toBe(alternative);
    } finally {
      restorePlanning();
      restoreCatalogue();
      restoreProvider();
    }
  } finally {
    try {
      if (owned) {
        await database.client`DELETE FROM factory.ticket_conversation
          WHERE project_id = ${owned.projectID} AND created_by = ${owned.userID}`;
        await owned.dispose();
      } else await database.client.end();
    } finally {
      await process.dispose();
    }
  }
}, 60_000);

function processEnv(key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}

test("relay streams the active exact model and rejects revoked/runtime/token authority", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  let owned: Awaited<ReturnType<typeof fixture>> | undefined;
  let calls = 0;
  const inFlight = Promise.withResolvers<void>();
  const finishInFlight = Promise.withResolvers<void>();
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      calls += 1;
      expect(request.headers.get("authorization")).toBe("Bearer owned-provider-key");
      expect(((await request.json()) as { model: string }).model).toBe(build);
      if (calls === 2) {
        inFlight.resolve();
        await finishInFlight.promise;
      }
      return new Response("data: owned-stream\n\n", {
        headers: { "content-type": "text/event-stream", "x-secret-header": "never-forward" },
      });
    },
  });
  try {
    await process.start();
    owned = await fixture(undefined, undefined, database);
    const admission = createChangeAdmission(database, build);
    const admitted = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    const turns = createAgentTurnStore(database);
    const owner = await turns.claimPending(admitted.turn.id, 60_000);
    if (!owner?.ownerToken) throw new Error("Owned turn was not claimed");
    await turns.beginDispatch(owner.id, owner.ownerToken);
    await database.client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${owner.id}`;
    await database.client`UPDATE factory.change_agent_session SET active_turn_id = ${owner.id}, state = 'working',
      opencode_session_id = (SELECT session_id FROM factory.change_agent_turn_intent WHERE turn_id = ${owner.id}) WHERE change_id = ${owned.changeID}`;
    const secret = "owned-relay-secret";
    const attemptID = owned.attemptID;
    const relay = createModelRelay(database, secret, {
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      apiKey: "owned-provider-key",
    });
    const request = (
      model = build,
      token = runtimeModelToken(secret, attemptID, 1),
      body = JSON.stringify({ model, stream: true, reasoning: { effort: "medium" } }),
    ) =>
      new Request("http://factory.invalid/internal/model", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
    expect((await relay(request(alternative), owned.attemptID, "responses")).status).toBe(403);
    expect((await relay(request(build, "invalid"), owned.attemptID, "responses")).status).toBe(401);
    expect(
      (
        await relay(
          request(build, runtimeModelToken(secret, owned.attemptID, 2)),
          owned.attemptID,
          "responses",
        )
      ).status,
    ).toBe(401);
    expect(
      (await relay(request(build, undefined, "not-json"), owned.attemptID, "responses")).status,
    ).toBe(400);
    expect((await relay(request(), owned.attemptID, "models")).status).toBe(404);
    const oversized = JSON.stringify({ model: build, padding: "x".repeat(4_194_304) });
    expect(
      (await relay(request(build, undefined, oversized), owned.attemptID, "responses")).status,
    ).toBe(413);
    const streamed = new Request("http://factory.invalid/internal/model", {
      method: "POST",
      headers: { authorization: `Bearer ${runtimeModelToken(secret, attemptID, 1)}` },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized.slice(0, 2_097_152)));
          controller.enqueue(new TextEncoder().encode(oversized.slice(2_097_152)));
          controller.close();
        },
      }),
    });
    expect((await relay(streamed, owned.attemptID, "responses")).status).toBe(413);
    for (const effort of [undefined, "none", "low", "high"]) {
      expect(
        (
          await relay(
            request(build, undefined, JSON.stringify({ model: build, reasoning: { effort } })),
            owned.attemptID,
            "responses",
          )
        ).status,
      ).toBe(403);
    }
    expect((await relay(request(), owned.attemptID, "chat/completions")).status).toBe(403);
    expect(
      (
        await relay(
          request(
            build,
            undefined,
            JSON.stringify({
              model: build,
              reasoning: { effort: "medium" },
              input: [{ type: "configuration_update", reasoning: { effort: "low" } }],
            }),
          ),
          owned.attemptID,
          "responses",
        )
      ).status,
    ).toBe(403);
    expect(calls).toBe(0);
    const response = await relay(request(), owned.attemptID, "responses");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: owned-stream\n\n");
    expect(response.headers.get("x-secret-header")).toBeNull();
    expect(calls).toBe(1);
    const dispatched = relay(request(), owned.attemptID, "responses");
    await inFlight.promise;
    await database.client`UPDATE factory.change_agent_session SET state = 'stopped' WHERE change_id = ${owned.changeID}`;
    expect((await relay(request(), owned.attemptID, "responses")).status).toBe(403);
    expect(calls).toBe(2);
    finishInFlight.resolve();
    // Stop rejects the next call, not an already dispatched provider's result or bill.
    expect(await (await dispatched).text()).toBe("data: owned-stream\n\n");
  } finally {
    finishInFlight.resolve();
    await provider.stop(true);
    try {
      if (owned) await owned.dispose();
      else await database.client.end();
    } finally {
      await process.dispose();
    }
  }
}, 60_000);
