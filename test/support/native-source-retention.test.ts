import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { runProcess } from "../../scripts/owned-client-process";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";
import { requireOwnedProjectSourceRetention } from "../fixtures/editor-source-resources";
import { releaseSourceFile } from "../fixtures/release-cleanup";

async function liveCleanupProbe(owner: "starter" | "recovery", mode = "completed") {
  const path = resolve(
    `test/integration/${owner === "starter" ? "starter-runtime" : "agent-commit-runtime-recovery"}.live.test.ts`,
  );
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest);
  const blocks: ts.Block[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isTryStatement(node) &&
      node.finallyBlock
        ?.getText(source)
        .includes(
          owner === "starter"
            ? "const { projectID, setupID } = ownership"
            : "for (const opened of terminals)",
        )
    )
      blocks.push(node.finallyBlock);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (!block) throw Error("Live fixture finalizer missing");
  // Execute only the saved finalizer, never import/register/run the paid live
  // test. All IO below is controlled; no browser, database or native API starts.
  const body = ts.transpileModule(block.getText(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.None,
      alwaysStrict: false,
    },
  }).outputText;
  const projectID = crypto.randomUUID();
  const workspaceID = crypto.randomUUID();
  const workspaceAttemptID = crypto.randomUUID();
  const isolatedID = crypto.randomUUID();
  const events: string[] = [];
  const receipts: Record<string, unknown>[] = [];
  const workspaceAttempt = { id: workspaceAttemptID, workspaceID, state: "ready" };
  const isolatedAttempt = { id: isolatedID, workspaceID: null, state: "ready" };
  const attempts = [workspaceAttempt, isolatedAttempt];
  const base = "https://owned.factory.invalid";
  const slug = "owned-starter-12345678";
  const process = {
    id: crypto.randomUUID(),
    base,
    processes: [{ exitCode: null }],
    start: async () => events.push("local-start"),
    signIn: async () => "owned-session",
    pause: async () => events.push("local-pause"),
    dispose: async () => events.push("dispose"),
  };
  const bindings = {
    expect,
    serverCall,
    join,
    projectID,
    ownership: { projectID: mode === "empty" ? "" : projectID, setupID: "", slug },
    succeeded: mode !== "failed" && mode !== "empty",
    cookie: "owned-session",
    slug,
    identity: { changeID: crypto.randomUUID(), branchName: "owned-branch" },
    branchCreateIntended: true,
    recoveredSHA: "a".repeat(40),
    evidenceDirectory: "/owned/evidence",
    directory: "/owned/starter",
    nativeLifecycleWindowMS: 1000,
    factory: process,
    processFixture: process,
    attempts: async () => attempts,
    browser: { close: async () => events.push("browser-close") },
    terminals: [{ close: () => events.push("terminal-close") }],
    bao: { dispose: async () => events.push("bao-dispose") },
    mkdir: async () => {},
    rm: async () => events.push("rm"),
    console: { log: () => {} },
    fetch: async (url: string) => {
      expect(url).toBe(`${base}/health/ready`);
      return new Response(null, { status: 200 });
    },
    writeFile: async (file: string, data: string) => {
      const receipt = JSON.parse(data) as Record<string, unknown>;
      if (mode === "receipt-lost" && !file.includes("final-pause-"))
        throw Error("Owned retention receipt write failed");
      receipts.push(receipt);
    },
    database: {
      client: Object.assign(
        async (parts: TemplateStringsArray) => {
          const sql = parts.join("?");
          expect(sql.trimStart()).toStartWith("SELECT");
          if (sql.includes("project.slug"))
            return [{ slug, state: mode === "delivered" ? "delivered" : "active" }];
          if (sql.includes("runtime_attempt")) return attempts;
          throw Error("Unexpected fixture SQL");
        },
        { end: async () => events.push("database-close") },
      ),
    },
    callFactoryFunction: async (_base: string, name: string, args: string[]) => {
      events.push(name);
      if (name === "stopRuntimeAttempt") {
        expect(args).toEqual([isolatedID]);
        isolatedAttempt.state = "stopped";
      } else expect(["stopCoding", "cancelChange"]).toContain(name);
      return { ok: true, value: {} };
    },
    connectStarterNativeLifecycle: async (origin: string, cookie: string) => {
      expect([origin, cookie]).toEqual([base, "owned-session"]);
      return {
        pause: async (selected: string, requestID: string) => {
          events.push("pauseWorkspace");
          expect(selected).toBe(workspaceID);
          expect(receipts).toContainEqual({ projectID, workspaceID, requestID });
          if (mode === "lost") throw Error("Owned Pause reply lost");
          workspaceAttempt.state = mode === "pending" ? "pausing" : "paused";
          return { id: workspaceAttemptID, projectId: projectID, workspaceId: workspaceID };
        },
        close: async () => events.push("mcp-close"),
      };
    },
    eventually: async (
      read: () => Promise<unknown>,
      accepts: (value: unknown) => boolean,
      message: string,
    ) => {
      const value = await read();
      if (!accepts(value)) throw Error(message);
      return value;
    },
  };
  let error: unknown;
  try {
    await new Function(...Object.keys(bindings), `return (async () => ${body})();`)(
      ...Object.values(bindings),
    );
  } catch (cause) {
    error = cause;
  }
  return { events, receipts, error };
}

test.each(["starter", "recovery"] as const)(
  "%s live finalizer pauses Workspace, stops isolated work, and retains fixture data",
  async (owner) => {
    const result = await liveCleanupProbe(owner);
    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event === "pauseWorkspace")).toHaveLength(1);
    expect(result.events.filter((event) => event === "stopRuntimeAttempt")).toHaveLength(1);
    expect(result.events.slice(-2)).toEqual(["database-close", "local-pause"]);
    expect(result.events).not.toContain("dispose");
    expect(result.events).not.toContain("bao-dispose");
    expect(result.events).not.toContain("rm");
    expect(JSON.stringify(result.receipts.at(-1))).toContain('"destructiveDisposal":false');
    expect(JSON.stringify(result.receipts.at(-1))).toContain('"haltConfirmed":true');
  },
);

for (const owner of ["starter", "recovery"] as const)
  test.each(["lost", "pending", "receipt-lost"])(
    `${owner} live finalizer retains data and closes local clients on %s outcome`,
    async (mode) => {
      const result = await liveCleanupProbe(owner, mode);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.events.filter((event) => event === "pauseWorkspace")).toHaveLength(1);
      expect(result.events).toContain("mcp-close");
      expect(result.events.slice(-2)).toEqual(["database-close", "local-pause"]);
      expect(result.events).not.toContain("dispose");
      if (mode !== "receipt-lost")
        expect(JSON.stringify(result.receipts.at(-1))).toContain('"haltConfirmed":false');
    },
  );

test("failed Starter retains admitted work without implicit Coding cancellation or Pause", async () => {
  const result = await liveCleanupProbe("starter", "failed");
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual(["browser-close", "database-close", "local-pause"]);
});

test("only an empty unadmitted Starter uses the existing guarded local disposal", async () => {
  const result = await liveCleanupProbe("starter", "empty");
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([
    "browser-close",
    "database-close",
    "dispose",
    "bao-dispose",
    "rm",
  ]);
});

test("recovery keeps explicit Coding cancellation distinct and does not cancel delivered work", async () => {
  const active = await liveCleanupProbe("recovery");
  expect(active.error).toBeUndefined();
  expect(active.events.filter((event) => ["stopCoding", "cancelChange"].includes(event))).toEqual([
    "stopCoding",
    "cancelChange",
  ]);
  expect(active.events.indexOf("cancelChange")).toBeLessThan(
    active.events.indexOf("pauseWorkspace"),
  );
  const delivered = await liveCleanupProbe("recovery", "delivered");
  expect(delivered.error).toBeUndefined();
  expect(delivered.events).not.toContain("stopCoding");
  expect(delivered.events).not.toContain("cancelChange");
});

async function projectCleanupProbe(mode: string) {
  // Keep transport doubles in a child; other suites retain their real MCP and
  // compiled server-function owners. No installation or database is contacted.
  const script = `
    const { mock } = await import("bun:test");
    const mode = ${JSON.stringify(mode)};
    const events = [];
    const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
    const actorUID = crypto.randomUUID(), workspaceAttemptID = crypto.randomUUID();
    const isolatedID = crypto.randomUUID();
    const workspace = {
      id: workspaceAttemptID, projectId, workspaceId, state: "ready",
      native: { engine: "substrate", actorUID, state: "ACTOR_STATE_RUNNING",
        coldRestart: true, portable: false, sourceHandoff: "confirmed-same-node" },
    };
    const attempts = [
      ...(mode === "isolated" || mode === "empty" ? [] : [workspace]),
      ...(mode === "empty" ? [] : [{ id: isolatedID, projectId, state: "ready" }]),
      ...(mode === "empty" ? [] : [{ id: crypto.randomUUID(), projectId, state: "failed" }]),
    ];
    if (mode === "paused") {
      workspace.state = "paused";
      attempts.find(attempt => attempt.id === isolatedID).state = "stopped";
    }
    mock.module(${JSON.stringify(resolve("test/fixtures/server-functions.ts"))}, () => ({
      requestFunction: async (_request, name, args) => {
        events.push({ name, args });
        if (name === "getRuntimeAttempts") return { ok: true, value: { attempts } };
        if (name !== "stopRuntimeAttempt") throw Error("Unexpected product command");
        const attempt = attempts.find(attempt => attempt.id === args[0]);
        if (attempt.workspaceId) throw Error("Workspace Stop is forbidden");
        attempt.state = "stopped";
        return { ok: true, value: attempt };
      },
    }));
    mock.module(${JSON.stringify(resolve("test/fixtures/mcp-authorization.ts"))}, () => ({
      ownedMCPAuthorization: async (base, cookie) => {
        if (base !== "https://factory.example" || cookie !== "owned-session=fixture")
          throw Error("Only this fixture's authenticated session may approve Pause");
        events.push({ name: "authorize" });
        return {};
      },
      ownedMCPAuthProvider: () => ({}),
    }));
    mock.module("@modelcontextprotocol/client", () => ({
      StreamableHTTPClientTransport: class {},
      Client: class {
        async connect() { events.push({ name: "connect" }); }
        async callTool(input) {
          events.push(input);
          if (input.name !== "pauseWorkspace") throw Error("Unexpected MCP operation");
          if (input.arguments.workspaceID !== workspaceId ||
              !/^[a-f0-9-]{36}$/.test(input.arguments.requestID))
            throw Error("Pause must bind this Workspace and an explicit request identity");
          if (mode === "lost") throw Error("Owned Pause reply lost");
          const value = mode === "uncertain" ? { state: "uncertain" } :
            { ...workspace, state: "paused",
              ...(mode === "foreign" ? { workspaceId: crypto.randomUUID() } : {}),
              ...(mode === "foreign-actor"
                ? { native: { ...workspace.native, actorUID: crypto.randomUUID() } } : {}) };
          if (mode !== "denied") workspace.state = "paused";
          return { isError: mode === "denied",
            content: [{ type: "text", text: JSON.stringify(value) }] };
        }
        async close() { events.push({ name: "close" }); }
      },
    }));
    const database = await import(${JSON.stringify(resolve("packages/db/src/client.ts"))});
    const createDatabase = () => {
      events.push({ name: "database" });
      throw Error("Project deletion must not contact a database with retained Workspace Source");
    };
    mock.module(${JSON.stringify(resolve("packages/db/src/client.ts"))},
      () => ({ ...database, createDatabase }));
    globalThis.fetch = async () => { throw Error("Unexpected network access"); };
    const fixture = await import(${JSON.stringify(resolve("test/support/factory-fixture.ts"))});
    const request = { storageState: async () => ({ cookies: [
      { name: "foreign-session", value: "not-owned", domain: "other.example", path: "/" },
      { name: "expired-session", value: "expired", domain: "factory.example", path: "/",
        expires: 1, secure: true },
      { name: "other-path", value: "not-authorized", domain: "factory.example", path: "/other",
        expires: -1, secure: true },
      { name: "foreign-prefix", value: "not-owned", domain: "otherfactory.example", path: "/",
        expires: -1, secure: true },
      { name: "owned-session", value: "fixture", domain: "factory.example", path: "/",
        expires: -1, secure: true },
    ].filter(cookie => mode !== "unauthenticated" || cookie.name === "foreign-session") }) };
    let error;
    try {
      if (mode === "teardown") await fixture.teardownFactoryProject(request, projectId);
      else await fixture.stopProjectRuntimes(request, projectId);
    } catch (cause) { error = cause.message; }
    console.log(JSON.stringify({ events, error, workspaceAttemptID, isolatedID, workspaceId }));
  `;
  const result = await runProcess([process.execPath, "--no-env-file", "-e", script], {
    env: verificationEnvironment({
      ...process.env,
      FACTORY_BROWSER_BASE_URL: "https://factory.example",
    }),
    signal: AbortSignal.timeout(8_000),
  });
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as {
    error?: string;
    events: Array<{ name: string; args?: string[]; arguments?: { workspaceID: string } }>;
    workspaceAttemptID: string;
    isolatedID: string;
    workspaceId: string;
  };
}

test("Project fixture cleanup pauses retained Workspaces and only stops isolated attempts", async () => {
  const result = await projectCleanupProbe("mixed");
  expect(result.error).toBeUndefined();
  expect(result.events.filter((event) => event.name === "pauseWorkspace")).toMatchObject([
    { arguments: { workspaceID: result.workspaceId } },
  ]);
  expect(result.events.filter((event) => event.name === "stopRuntimeAttempt")).toEqual([
    { name: "stopRuntimeAttempt", args: [result.isolatedID] },
  ]);
  expect(result.events.filter((event) => event.name === "close")).toHaveLength(1);
});

test.each(["isolated", "paused", "empty"])(
  "Project fixture cleanup needs no Workspace grant for %s attempts",
  async (mode) => {
    const result = await projectCleanupProbe(mode);
    expect(result.error).toBeUndefined();
    expect(
      result.events.filter((event) =>
        ["authorize", "connect", "pauseWorkspace", "close", "database"].includes(event.name),
      ),
    ).toEqual([]);
  },
);

test.each(["lost", "uncertain", "denied", "foreign", "foreign-actor"])(
  "Project fixture cleanup never retries or deletes after a %s Pause outcome",
  async (mode) => {
    const result = await projectCleanupProbe(mode);
    expect(result.error).toBeDefined();
    expect(result.events.filter((event) => event.name === "pauseWorkspace")).toHaveLength(1);
    expect(result.events.filter((event) => event.name === "close")).toHaveLength(1);
    expect(
      result.events.filter((event) =>
        ["database", "stopRuntimeAttempt", "stopCoding", "cancelChange"].includes(event.name),
      ),
    ).toEqual([]);
  },
);

test("Project fixture cleanup requires its own authenticated session before admitting Pause", async () => {
  const result = await projectCleanupProbe("unauthenticated");
  expect(result.error).toContain("authenticated fixture session");
  expect(
    result.events.filter((event) =>
      ["authorize", "connect", "pauseWorkspace", "database"].includes(event.name),
    ),
  ).toEqual([]);
});

test("Project teardown retains Workspace Actor/Source and reports the missing destructive boundary", async () => {
  const result = await projectCleanupProbe("teardown");
  expect(result.error).toContain("explicit disposable Workspace teardown");
  expect(result.events.filter((event) => event.name === "pauseWorkspace")).toHaveLength(1);
  expect(result.events.filter((event) => event.name === "database")).toEqual([]);
});

test("release Source proof decodes the native file bytes and rejects mismatched versions or text encoding", () => {
  const contract = {
    version: 1 as const,
    primaryApp: "web",
    apps: [
      { id: "web", label: "Owned App", command: ["node", "web.js"], port: 4321, healthPath: "/" },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(contract));
  const file = {
    content: bytes.toString("base64"),
    version: createHash("sha256").update(bytes).digest("hex"),
  };
  expect(releaseSourceFile(file)).toEqual({ version: file.version, contract });
  expect(() => releaseSourceFile({ ...file, version: "f".repeat(64) })).toThrow("reported version");
  expect(() => releaseSourceFile({ ...file, content: bytes.toString() })).toThrow();
});

test("native fixture teardown only observes Source retention and refuses unsettled recorded owners", async () => {
  let unsettled: { kind: string }[] = [];
  const queries: string[] = [];
  const projectID = crypto.randomUUID();
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(parts.join("?"));
    expect(values).toEqual([projectID, projectID]);
    return unsettled;
  };
  const database = { client: sql } as unknown as Parameters<
    typeof requireOwnedProjectSourceRetention
  >[0];
  await requireOwnedProjectSourceRetention(database, projectID);
  expect(queries.every((query) => query.trimStart().startsWith("SELECT"))).toBe(true);
  expect(queries[0]).toContain("attempt.deleted_at IS NULL");
  expect(queries[0]).toContain("source.owner<>'service'");
  for (const kind of ["runtime", "source"]) {
    unsettled = [{ kind }];
    await expect(requireOwnedProjectSourceRetention(database, projectID)).rejects.toThrow(
      "no data was released",
    );
  }
});
