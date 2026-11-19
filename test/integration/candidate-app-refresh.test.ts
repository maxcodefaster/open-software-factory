import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createBuildBrowserController } from "../../apps/factory/src/agent/browser-controller";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import type { AgentTurnTransaction } from "../../apps/factory/src/agent/turn-store";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import type { RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { candidateReviewPermissions } from "../../packages/conversation-domain/src/candidate-review";
import { createDatabase } from "../../packages/db/src/client";
import { nativeLifecycleWindowMS } from "../../packages/runtime-domain/src/timing";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { eventually } from "../fixtures/factory-process";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { fixtureRuntime } from "../fixtures/substrate";

// Real Agent/Runtime/Browser controllers, Turn/Writer stores, Hub and PostgreSQL.
// Only Connector/OpenCode peers are controlled. No Actor or inference is started.
let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);

async function appReview(apps: boolean | "missing" | "partial" | "multiple" = true) {
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    DATABASE_URL: target.url,
    FACTORY_FORGEJO_API_URL: "https://owned-build.factory.invalid/api/v1/",
    FACTORY_FORGEJO_TOKEN: "owned-no-network",
    FACTORY_FORGEJO_OWNER: "owned",
    FACTORY_AUTH_SECRET: "owned-candidate-app-refresh-signing-secret",
  })) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const database = createDatabase(4);
  let cleanup = async () => {
    try {
      await database.client.end({ timeout: 1 });
      await target.dispose();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  try {
    let head = "";
    let branch = "";
    let files: { path: string; status: string }[] = [];
    let loadedCandidate = false;
    let healthy = true;
    let loseRestartAck = false;
    let dirtyAfterRestart = false;
    const events: string[] = [];
    const sessions = new Map<string, Record<string, unknown>>();
    let healthReads = 0;
    let sessionReads = 0;
    let beforeRestart: (() => Promise<void>) | undefined;
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") return new Response(null, { status: healthy ? 200 : 503 });
        if (path === "/invoices/known") return Response.json({ total: 12 });
        return loadedCandidate
          ? Response.json({ total: null }, { status: 404 })
          : Response.json({ error: "Invoice lookup failed" }, { status: 500 });
      },
    });
    const closeDatabase = cleanup;
    cleanup = async () => {
      app.stop(true);
      await closeDatabase();
    };
    const declared =
      apps === false
        ? []
        : apps === "partial" || apps === "multiple"
          ? ["app", "app-api"]
          : ["app"];
    const advertised = apps === "missing" ? [] : apps === "partial" ? ["app"] : declared;
    const contract = {
      version: 1,
      primaryApp: "web",
      apps: [
        {
          id: "web",
          label: "Invoice service",
          command: ["node", "src/server.mjs"],
          port: app.port,
          healthPath: "/health",
        },
      ],
    };
    if (apps === "partial" || apps === "multiple")
      contract.apps.push({
        id: "api",
        label: "Declared secondary App",
        command: ["node", "api.mjs"],
        port: app.port === 65535 ? 65534 : (app.port ?? 4300) + 1,
        healthPath: "/health",
      });
    // Retain the native declaration before the existing fixture inserts its
    // uncreated Attempt, as production requires. Never disable database guards.
    const begin = database.client.begin.bind(database.client);
    const seededDatabase = {
      ...database,
      client: new Proxy(database.client, {
        get(target, key, receiver) {
          if (key !== "begin") return Reflect.get(target, key, receiver);
          return (work: (sql: AgentTurnTransaction) => Promise<unknown>) =>
            begin((sql) =>
              work(
                new Proxy(sql, {
                  apply(target, receiver, args) {
                    const text = Array.isArray(args[0]) ? args[0].join(" ") : "";
                    if (text.includes("INSERT INTO factory.runtime_attempt")) {
                      return (async () => {
                        await sql`INSERT INTO factory.branch_create_operation(
                  id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
                  SELECT gen_random_uuid(),id,'owned','review',branch_name,base_sha,id::text,'succeeded',base_sha,now()
                  FROM factory.change`;
                        if (apps !== false)
                          await sql`INSERT INTO factory.substrate_workspace(workspace_id,generation,intent)
                  SELECT id,1,${JSON.stringify({ systemContract: contract })}::jsonb
                  FROM factory.development_workspace`;
                        const result = await Reflect.apply(target, receiver, args);
                        await sql`UPDATE factory.runtime_attempt SET declared_apps=${JSON.stringify(declared)}::jsonb`;
                        return result;
                      })();
                    }
                    return Reflect.apply(target, receiver, args);
                  },
                }),
              ),
            );
        },
      }),
    } as typeof database;
    const f = await candidateReviewFixture(undefined, seededDatabase);
    const closeApp = cleanup;
    cleanup = async () => {
      try {
        await f.shutdown();
      } finally {
        f.restoreEnvironment();
        await closeApp();
      }
    };
    const [change] = await database.client<{ branch: string }[]>`
    SELECT branch_name AS branch FROM factory.change WHERE id=${f.changeID}`;
    if (!change) throw Error("Missing owned Ticket");
    head = f.commit;
    branch = change.branch;
    const configuration: SubstrateInstallationConfiguration = {
      deployment: "owned-test",
      database: "owned_candidate_app_refresh",
      connection: {
        bridge: "/never-run",
        endpoint: "127.0.0.1:1",
        serverName: "api.ate-system.svc",
        caFile: "/unused/ca",
        tokenFile: "/unused/token",
      },
      provisioner: {
        bridge: "/never-run",
        endpoint: "127.0.0.1:1",
        serverName: "api.ate-system.svc",
        caFile: "/unused/ca",
        tokenFile: "/unused/token",
      },
      editorPrincipal: "user:system:serviceaccount:owned:factory-control",
      connectorURL: "wss://owned-build.factory.invalid/internal/runtime-connect",
      factoryCAFile: "/unused/factory-ca",
      workloadImage: `registry.invalid/owned@sha256:${"a".repeat(64)}`,
      profile: "nightly-20261109-975fb172241c",
      runtime: fixtureRuntime,
      workerSelector: {
        "factory.runtime/profile": "nightly-20261109-975fb172241c",
        "factory.dev/deployment": "owned",
      },
      egressHosts: [],
    };
    const runtime = createRuntimeController(database, f.hub, "owned", {
      configuration,
      call: async () => {
        throw Error("Candidate review must not call native lifecycle");
      },
      provisionerCall: async () => {
        throw Error("Candidate review must not provision");
      },
    });
    runtime.startPersisted = async () => {
      throw Error("Ready review must keep the original Actor");
    };
    const child = {
      data: { kind: "connector", role: "child", attemptID: f.attemptID, generation: 1 },
      close() {},
      send(raw: string) {
        const frame = JSON.parse(raw);
        if (frame.type !== "operation-request") return 1;
        expect(frame.action).toBe("process-restart");
        expect(declared).toContain(frame.process);
        events.push("restart", `restart:${frame.process}`);
        if (frame.process === "app") loadedCandidate = true;
        if (dirtyAfterRestart) files = [{ path: "src/invoice.mjs", status: " M" }];
        f.hub.message(
          child,
          JSON.stringify({
            type: "process-state",
            process: frame.process,
            processState: "running",
          }),
        );
        if (loseRestartAck) queueMicrotask(() => f.hub.close(child));
        else
          f.hub.message(
            child,
            JSON.stringify({ type: "operation-response", operationId: frame.operationId }),
          );
        return 1;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    function connect() {
      f.hub.open(child);
      f.hub.message(
        child,
        JSON.stringify({
          type: "hello",
          role: "child",
          channels: [
            ...advertised.map((name) => ({ name, kind: "app" })),
            { name: "ide", kind: "ide" },
          ],
        }),
      );
    }
    connect();
    const childRequest = f.hub.childRequest.bind(f.hub);
    f.hub.childRequest = async (attempt, input, beforeSend) => {
      expect(attempt).toBe(f.attemptID);
      await beforeRestart?.();
      return childRequest(attempt, input, beforeSend);
    };
    f.hub.parentOperation = async (attempt, input, beforeSend) => {
      expect(attempt).toBe(f.attemptID);
      let sent = !beforeSend;
      await beforeSend?.(() => {
        sent = true;
      });
      if (!sent) throw Error("Parent send not authorized");
      if (input.action === "browser-close") return {};
      expect(input.action).toBe("workspace-git");
      expect(JSON.parse(String(input["data"]))).toEqual({
        action: "status",
        branch: change.branch,
      });
      events.push("checkout");
      return { data: JSON.stringify({ head, branch, files }) };
    };
    const request = f.hub.request.bind(f.hub);
    f.hub.request = async (attempt, channel, input, path, beforeSend, ...rest) => {
      expect(attempt).toBe(f.attemptID);
      let sent = !beforeSend;
      await beforeSend?.(() => {
        sent = true;
      });
      if (!sent) throw Error("Request send not authorized");
      if (declared.includes(channel)) {
        expect(path).toBe("/health");
        expect(input.headers.has("cookie")).toBe(false);
        healthReads++;
        events.push("health");
        return fetch(new URL(path, app.url), { signal: input.signal });
      }
      const url = new URL(input.url).pathname;
      if (url === "/api/session" && input.method === "POST") {
        const body = (await input.json()) as { id: string };
        sessions.set(body.id, body);
        events.push("review-session");
        return Response.json({ data: body });
      }
      if (/^\/api\/session\/ses_factory_review_[^/]+$/.test(url)) {
        sessionReads++;
        const id = url.split("/").at(-1) ?? "";
        const session = sessions.get(id);
        if (session && input.method === "PATCH") {
          sessions.set(id, { ...session, ...(await input.json()) });
          return new Response(null, { status: 204 });
        }
        return session
          ? Response.json({ data: session })
          : Response.json({ message: "Owned Session absent" }, { status: 404 });
      }
      if (input.method === "POST" && url.endsWith("/prompt")) {
        events.push("prompt-boundary");
        throw Error("Owned stop before inference");
      }
      return request(attempt, channel, input, path, undefined, ...rest);
    };
    const browser = createBuildBrowserController(database, f.hub, "owned-no-browser-start");
    const prepare = browser.prepare.bind(browser);
    browser.prepare = async (...args) => {
      events.push("browser-grant");
      return prepare(...args);
    };
    const controllers: ReturnType<typeof createAgentController>[] = [];
    function controller() {
      const active = createAgentController(database, f.hub, runtime, browser, f.writers);
      controllers.push(active);
      return active;
    }
    return {
      ...f,
      events,
      sessions,
      controller,
      setHealthy(value: boolean) {
        healthy = value;
      },
      setMismatch(kind: "head" | "branch" | "dirty") {
        if (kind === "head") head = "b".repeat(40);
        if (kind === "branch") branch = "another-ticket";
        if (kind === "dirty") files = [{ path: "src/invoice.mjs", status: " M" }];
      },
      revokeBeforeRestart() {
        beforeRestart = async () => {
          await database.client`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()-interval '1 second'
          WHERE command_id=${f.reviewID}`;
          events.push("revoked-before-send");
        };
      },
      stopBeforeRestart() {
        beforeRestart = async () => {
          await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${f.attemptID}`;
          events.push("stopped-before-send");
        };
      },
      dirtyOnRestart() {
        dirtyAfterRestart = true;
      },
      failProcess() {
        f.hub.message(
          child,
          JSON.stringify({ type: "process-state", process: "app", processState: "failed" }),
        );
      },
      loseAck() {
        loseRestartAck = true;
      },
      healthReads: () => healthReads,
      sessionReads: () => sessionReads,
      response: () => fetch(new URL("/invoices/missing", app.url)),
      async dispatch() {
        const active = controller();
        await active.review(f.changeID, f.reviewID, f.userID);
        return active;
      },
      async settled() {
        return eventually(
          () => f.turn(f.reviewID),
          (turn) => !!turn && ["failed", "uncertain"].includes(turn.state),
          "Review dispatch did not settle",
        );
      },
      async recover() {
        connect();
        await database.client`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()-interval '1 second'
        WHERE command_id=${f.reviewID} AND owner_token IS NOT NULL`;
        await controller().recover();
        await eventually(
          async () => sessionReads,
          (count) => count > 0,
          "Recovery did not observe the original Session",
        );
      },
      async close() {
        try {
          await Promise.all(controllers.map((active) => active.shutdown()));
        } finally {
          f.hub.revoke(f.attemptID);
          await cleanup();
        }
      },
    };
  } catch (cause) {
    await cleanup();
    throw cause;
  }
}

test("candidate App refresh precedes independent read-only review on the same Actor", async () => {
  const f = await appReview();
  try {
    expect((await f.response()).status).toBe(500);
    await f.dispatch();
    expect((await f.settled())?.summary).toContain("Owned stop before inference");
    expect((await f.response()).status).toBe(404);
    expect(f.events.indexOf("checkout")).toBeLessThan(f.events.indexOf("restart"));
    expect(f.events.indexOf("restart")).toBeLessThan(f.events.indexOf("health"));
    expect(f.events.indexOf("health")).toBeLessThan(f.events.indexOf("review-session"));
    expect(f.events.indexOf("review-session")).toBeLessThan(f.events.indexOf("browser-grant"));
    expect([...f.sessions.values()][0]?.["permissions"]).toEqual([
      ...candidateReviewPermissions,
      { action: "question", resource: "*", effect: "deny" },
    ]);
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
    expect(f.requests()).toBe(0);
    expect(
      (await f.database.client`SELECT id FROM factory.runtime_attempt`).map((row) => row["id"]),
    ).toEqual([f.attemptID]);
  } finally {
    await f.close();
  }
}, 30_000);

test("source-only zero-App review needs no process control", async () => {
  const f = await appReview(false);
  try {
    await f.dispatch();
    expect((await f.settled())?.summary).toContain("Owned stop before inference");
    expect(f.events).toContain("review-session");
    expect(f.events).toContain("browser-grant");
    expect(f.events).not.toContain("restart");
    expect(f.events).not.toContain("health");
    expect(f.requests()).toBe(0);
    expect(
      await f.database.client`SELECT workspace_id FROM factory.substrate_workspace`,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30_000);

test.each(["missing", "partial"] as const)(
  "candidate review refuses %s advertised App channels rather than skipping saved declarations",
  async (advertisement) => {
    const f = await appReview(advertisement);
    try {
      await f.dispatch();
      expect((await f.settled())?.summary).toContain("declared Apps");
      expect(f.events).not.toContain("restart");
      expect(f.events).not.toContain("health");
      expect(f.sessions.size).toBe(0);
      expect(f.events).not.toContain("browser-grant");
      expect(f.requests()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30_000,
);

test("candidate review refreshes and health-checks every admitted App on the original Attempt", async () => {
  const f = await appReview("multiple");
  try {
    await f.dispatch();
    expect((await f.settled())?.summary).toContain("Owned stop before inference");
    expect(f.events.filter((event) => event.startsWith("restart:"))).toEqual([
      "restart:app",
      "restart:app-api",
    ]);
    expect(f.healthReads()).toBe(2);
    expect(f.events.lastIndexOf("health")).toBeLessThan(f.events.indexOf("review-session"));
    expect((await f.response()).status).toBe(404);
    expect(f.requests()).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

test.each(["head", "branch", "dirty"] as const)(
  "candidate %s mismatch blocks restart and review admission",
  async (kind) => {
    const f = await appReview();
    try {
      f.setMismatch(kind);
      await f.dispatch();
      await f.settled();
      expect(f.events).not.toContain("restart");
      expect(f.sessions.size).toBe(0);
      expect(f.events).not.toContain("browser-grant");
    } finally {
      await f.close();
    }
  },
  30_000,
);

test("candidate App running is not readiness, delayed declared health gates review", async () => {
  const f = await appReview();
  try {
    f.setHealthy(false);
    await f.dispatch();
    await eventually(
      async () => f.events,
      (events) => events.includes("health") || events.includes("review-session"),
      "No preparation progress",
    );
    expect(f.healthReads()).toBeGreaterThan(0);
    expect(f.sessions.size).toBe(0);
    expect(f.events).not.toContain("browser-grant");
    f.setHealthy(true);
    await f.settled();
    expect(f.healthReads()).toBeGreaterThan(1);
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
    expect(f.events).toContain("browser-grant");
  } finally {
    await f.close();
  }
}, 30_000);

test("candidate restart revalidates writer authority at the actual child frame send", async () => {
  const f = await appReview();
  try {
    f.revokeBeforeRestart();
    await f.dispatch();
    await eventually(
      async () => f.events,
      (events) => events.includes("revoked-before-send") || events.includes("review-session"),
      "No dispatch progress",
    );
    expect(f.events).toContain("revoked-before-send");
    expect(f.events).not.toContain("restart");
    expect(f.sessions.size).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

test("unknown candidate restart outcome creates no review Session and recovery never replays restart", async () => {
  const f = await appReview();
  try {
    f.loseAck();
    const active = await f.dispatch();
    await f.settled();
    expect((await f.response()).status).toBe(404);
    expect(f.sessions.size).toBe(0);
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
    await active.shutdown();
    await f.recover();
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
    expect(f.events).not.toContain("browser-grant");
    expect(f.requests()).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

test("candidate preparation refuses a retired original Attempt at frame send", async () => {
  const f = await appReview();
  try {
    f.stopBeforeRestart();
    await f.dispatch();
    await f.settled();
    expect(f.events).toContain("stopped-before-send");
    expect(f.events).not.toContain("restart");
    expect(f.sessions.size).toBe(0);
    expect(f.events).not.toContain("browser-grant");
  } finally {
    await f.close();
  }
}, 30_000);

test("candidate checkout is checked again after App preparation", async () => {
  const f = await appReview();
  try {
    f.dirtyOnRestart();
    await f.dispatch();
    expect((await f.settled())?.summary).toContain("clean submitted candidate");
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
    expect(f.sessions.size).toBe(0);
    expect(f.events).not.toContain("browser-grant");
  } finally {
    await f.close();
  }
}, 30_000);

test("candidate App readiness ends on process failure without retrying restart", async () => {
  const f = await appReview();
  try {
    f.setHealthy(false);
    await f.dispatch();
    await eventually(
      async () => f.healthReads(),
      (count) => count > 0,
      "No health observation",
    );
    f.failProcess();
    expect((await f.settled())?.summary).toContain("stopped before readiness");
    expect(f.sessions.size).toBe(0);
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30_000);

test("candidate App readiness uses the existing elapsed lifecycle window", async () => {
  const f = await appReview();
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    f.setHealthy(false);
    await f.dispatch();
    await eventually(
      async () => f.healthReads(),
      (count) => count > 0,
      "No health observation",
    );
    const now = performance.now();
    clock = spyOn(performance, "now").mockReturnValue(now + nativeLifecycleWindowMS + 1);
    expect((await f.settled())?.summary).toContain("did not become ready");
    expect(f.sessions.size).toBe(0);
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
  } finally {
    clock?.mockRestore();
    await f.close();
  }
}, 30_000);

test("shutdown cancels candidate readiness before reviewer or browser admission", async () => {
  const f = await appReview();
  try {
    f.setHealthy(false);
    const active = await f.dispatch();
    await eventually(
      async () => f.healthReads(),
      (count) => count > 0,
      "No health observation",
    );
    await active.shutdown();
    expect(f.sessions.size).toBe(0);
    expect(f.events).not.toContain("browser-grant");
    expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30_000);
