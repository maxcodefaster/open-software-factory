import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  buildBrowserCallInput,
  buildBrowserToolCatalogue,
} from "#conversation-domain/browser-tools";
import { createBuildBrowserEndpoint } from "../../apps/factory/src/agent/browser-endpoint";
import {
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  ensureOpenCodeMessageBoundary,
} from "../../apps/factory/src/agent/opencode-adapter";
import {
  connectOpenCodeBrowser,
  connectOpenCodeSources,
} from "../../apps/factory/src/agent/opencode-browser";
import upstream from "../../upstream.json";
import { ownedBrowserJPEG } from "../fixtures/browser-image";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("local pinned OpenCode flushes a warm registry after explicitly observed delayed MCP connection", async () => {
  const serverPackage = await Bun.file(
    resolve("deploy/opencode-server/node_modules/@opencode/server/package.json"),
  ).json();
  const clientPackage = await Bun.file(
    resolve("node_modules/@opencode/client/package.json"),
  ).json();
  const corePackage = await Bun.file(
    resolve("deploy/opencode-server/node_modules/@opencode/core/package.json"),
  ).json();
  expect(serverPackage.version).toBe(upstream.openCode.version);
  expect(clientPackage.version).toBe(upstream.openCode.version);
  expect(corePackage.version).toBe(upstream.openCode.version);
  const scratch = await mkdtemp(resolve(tmpdir(), "factory-owned-mcp-readiness-"));
  const project = resolve(scratch, "project");
  await mkdir(resolve(project, ".git"), { recursive: true });
  const catalogues: string[][] = [];
  const calls: string[] = [];
  let catalogRequested = Promise.withResolvers<void>();
  let releaseCatalog = Promise.withResolvers<void>();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "owned-readiness", version: "1" });
    server.registerTool(
      "read_owned",
      {
        description: "Read the owned readiness fixture",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        throw new Error("Readiness qualification must not execute a tool");
      },
    );
    return server;
  });
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer owned-readiness-capability")
        return new Response(null, { status: 403 });
      if (request.method === "POST") {
        const rpc = (await request.clone().json()) as { method: string };
        calls.push(rpc.method);
        if (rpc.method === "tools/list") {
          catalogRequested.resolve();
          await releaseCatalog.promise;
        }
      }
      return handler.fetch(request);
    },
  });
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      expect(JSON.stringify(body)).not.toContain("owned-readiness-capability");
      catalogues.push(
        (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
      );
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        id: "owned-readiness",
        object: "chat.completion.chunk",
        model: buildModelID,
        choices: [{ index: 0, delta, finish_reason }],
      });
      return new Response(
        `data: ${JSON.stringify(chunk({ content: "Owned readiness response." }))}\n\n` +
          `data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const ready = Promise.withResolvers<number>();
  const serverModule = pathToFileURL(
    resolve("deploy/opencode-server/node_modules/@opencode/server/dist/process.js"),
  ).href;
  const effectModule = pathToFileURL(
    resolve("deploy/opencode-server/node_modules/effect/dist/index.js"),
  ).href;
  const config = {
    model: `factory/${buildModelID}`,
    providers: {
      factory: {
        package: "@opencode/ai/providers/openai/chat",
        canonical: "openai",
        env: [],
        settings: {
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "owned-not-a-secret",
        },
        models: {
          [buildModelID]: {
            name: "Owned readiness",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 200000, output: 32000 },
          },
        },
      },
    },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  };
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "--eval",
      `
        const { start } = await import(${JSON.stringify(serverModule)});
        const { Effect } = await import(${JSON.stringify(effectModule)});
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const server = yield* start(${JSON.stringify({
            app: { name: "factory", version: serverPackage.version },
            hostname: "127.0.0.1",
            port: 0,
            password: "owned-readiness-password",
            database: { path: resolve(project, ".git/opencode.db") },
            events: { persist: true },
            models: { fetch: false },
            config: {
              directory: resolve(scratch, "config"),
              project: false,
              content: JSON.stringify(config),
            },
            fs: { filewatcher: false, fff: false },
          })});
          console.log("OWNED_MCP_PORT=" + server.address.port);
          yield* server.shutdown;
        })));
      `,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: scratch,
        XDG_CONFIG_HOME: resolve(scratch, "config"),
        XDG_DATA_HOME: resolve(scratch, "data"),
        XDG_CACHE_HOME: resolve(scratch, "cache"),
        XDG_STATE_HOME: resolve(scratch, "state"),
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let output = "";
  const stdout = (async () => {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      const port = /OWNED_MCP_PORT=(\d+)/.exec(output)?.[1];
      if (port) ready.resolve(Number(port));
    }
  })();
  const stderr = new Response(child.stderr).text();
  void child.exited.then(async (status) => {
    ready.reject(new Error(`Owned local OpenCode exited ${status}: ${await stderr}`));
  });
  const startupTimeout = setTimeout(
    () => ready.reject(new Error("Owned local OpenCode startup timed out")),
    20_000,
  );
  const originalSleep = Bun.sleep;
  const sleep = spyOn(Bun, "sleep").mockImplementation((duration) => {
    if (duration === 150)
      throw new Error("Factory must not substitute a fixed wait for native readiness");
    return originalSleep(duration);
  });
  try {
    const port = await ready.promise;
    clearTimeout(startupTimeout);
    const client = createOpenCodeClient(async (request, path) => {
      const url = new URL(`http://127.0.0.1:${port}${path}`);
      // Map the runtime's fixed checkout to this fixture's owned local directory.
      if (url.searchParams.has("location[directory]"))
        url.searchParams.set("location[directory]", project);
      const body = request.body ? await request.json() : undefined;
      if (body?.location) body.location.directory = project;
      const headers = new Headers(request.headers);
      headers.set(
        "authorization",
        `Basic ${Buffer.from("opencode:owned-readiness-password").toString("base64")}`,
      );
      const response = await fetch(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
      return response;
    });
    const info = await client.server.info();
    expect(info.version).toBe(upstream.openCode.version);
    await observe(
      () =>
        client.model
          .list({ location: { directory: "/workspace/project" } })
          .then(() => true)
          .catch(() => false),
      Boolean,
    );
    const sessionID = `ses_readiness_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.session.create({
      id: sessionID,
      title: "Owned native readiness",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    const prompt = async () => {
      await client.session.prompt({
        sessionID,
        text: "Reply briefly without calling tools.",
        delivery: "queue",
        resume: true,
      });
      await observe(() => confirmSettledOpenCodeInput(client, sessionID, "owned"), Boolean);
    };
    await prompt();
    expect(catalogues.length).toBeGreaterThan(0);
    for (const [name, connect] of [
      ["factory_browser", connectOpenCodeBrowser],
      ["factory_sources", connectOpenCodeSources],
    ] as const) {
      const requestsBefore = catalogues.length;
      catalogRequested = Promise.withResolvers<void>();
      releaseCatalog = Promise.withResolvers<void>();
      const admission = connect(
        client,
        `http://127.0.0.1:${endpoint.port}/internal/build-browser/owned/turn`,
        "owned-readiness-capability",
      );
      // Keep a rejection handler attached while the catalogue request is held.
      let returned = false;
      const outcome = admission.then(
        () => {
          returned = true;
          return "returned" as const;
        },
        (cause: unknown) => cause,
      );
      try {
        await Promise.race([
          catalogRequested.promise,
          outcome.then((cause) => {
            throw cause;
          }),
        ]);
        const servers = await client.mcp.list({ location: { directory: "/workspace/project" } });
        expect(servers.data.find((server) => server.name === name)?.status.status).toBe("pending");
        expect(returned).toBe(false);
        expect(catalogues).toHaveLength(requestsBefore);
        releaseCatalog.resolve();
        await admission;
        expect(
          (await client.mcp.list({ location: { directory: "/workspace/project" } })).data.find(
            (server) => server.name === name,
          )?.status.status,
        ).toBe("connected");
        expect(calls).not.toContain("tools/call");
        expect(catalogues).toHaveLength(requestsBefore);
        // No Factory delay or paid prompt. Native SessionContext.select flushes
        // MCP tools before taking the permission-filtered registry snapshot.
        await prompt();
        expect(catalogues[requestsBefore]).toContain(`${name}_read_owned`);
      } finally {
        releaseCatalog.resolve();
        await outcome;
      }
    }
    await client.experimental.mcp.disconnect({
      server: "factory_browser",
      location: { directory: "/workspace/project" },
    });
    expect(
      (await client.mcp.list({ location: { directory: "/workspace/project" } })).data.find(
        (server) => server.name === "factory_browser",
      )?.status.status,
    ).toBe("disabled");
    const requestsBeforeDisconnect = catalogues.length;
    const disconnectedDispatch = async () => {
      await connectOpenCodeBrowser(
        client,
        `http://127.0.0.1:${endpoint.port}/internal/build-browser/owned/turn`,
        "owned-readiness-capability",
      );
      await prompt();
    };
    await expect(disconnectedDispatch()).rejects.toThrow(
      "The native Factory browser tools did not connect before Build dispatch",
    );
    expect(catalogues).toHaveLength(requestsBeforeDisconnect);
    expect(calls).not.toContain("tools/call");
    console.log("Owned local MCP readiness", {
      version: info.version,
      catalogues: catalogues.map((tools) => tools.filter((name) => name.startsWith("factory_"))),
      toolCalls: calls.filter((method) => method === "tools/call").length,
      disconnectedDispatch: "refused",
    });
  } finally {
    sleep.mockRestore();
    clearTimeout(startupTimeout);
    releaseCatalog.resolve();
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await child.exited;
    clearTimeout(forceKill);
    await stdout;
    await endpoint.stop(true);
    await provider.stop(true);
    await handler.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

test("pinned native MCP registration delivers browser images without a shell/read detour or source config", async () => {
  let authorized = true;
  const calls: string[] = [];
  let protectedCalls = 0;
  const session = {
    id: crypto.randomUUID(),
    ordinal: 1,
    turnID: crypto.randomUUID(),
    changeID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
    generation: 1,
    agentSessionID: "ses_owned_mcp",
    ownerID: "owned",
    state: "active" as const,
  };
  const facade = createBuildBrowserEndpoint({
    authorize: async (id, authorization) =>
      authorized && id === session.id && authorization === "Bearer owned-native-mcp-capability"
        ? { session, ownerToken: "owned" }
        : null,
    authorizeRuntime: async () => null,
    call: async (_session, _owner, call) => {
      expect(buildBrowserCallInput.parse(call).name).toBe("browser_screenshot");
      protectedCalls++;
      return {
        content: [{ type: "image", mimeType: "image/jpeg", data: ownedBrowserJPEG }],
        structuredContent: {
          sessionId: session.id,
          turnId: session.turnID,
          changeId: session.changeID,
          runtimeAttemptId: session.attemptID,
          generation: 1,
          app: "app",
          headCommit: "a".repeat(40),
          workingTreeModified: false,
          observedAt: new Date().toISOString(),
        },
      };
    },
  });
  const endpoint = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const rpc = (await request.clone().json()) as { method: string };
        calls.push(rpc.method);
      }
      return facade(request, session.id);
    },
  });
  const target = await pinnedOpenCode().catch(async (cause) => {
    await endpoint.stop(true);
    throw cause;
  });
  try {
    const filesBefore = await readdir(resolve(target.scratch, "project"));
    const sessionID = `ses_owned_mcp_${crypto.randomUUID().replaceAll("-", "")}`;
    await target.client.session.create({
      id: sessionID,
      title: "Native restricted browser",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await ensureOpenCodeMessageBoundary(target.client, sessionID);
    await target.control("/release", "POST");
    // Match retained Build sessions: the native tool registry has already been
    // used before Factory registers the browser immediately before a new turn.
    const warmPromptID = `msg_warm_${crypto.randomUUID().replaceAll("-", "")}`;
    await target.client.session.prompt({
      sessionID,
      id: warmPromptID,
      text: "Reply briefly without using tools.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => target.client.message.list({ sessionID, limit: 20 }),
      (page) =>
        page.data.some(
          (message) => message.type === "assistant" && Boolean(message.time.completed),
        ),
    );
    await observe(
      () => confirmSettledOpenCodeInput(target.client, sessionID, warmPromptID),
      Boolean,
    );
    const previousRequests = (await target.control()).providerRequests;
    await connectOpenCodeBrowser(
      target.client,
      `http://host.orb.internal:${endpoint.port}/fixed`,
      "owned-native-mcp-capability",
    );
    expect(calls).toContain("initialize");
    expect(calls).toContain("tools/list");
    await target.control("/browser-mcp", "POST");
    await target.client.session.prompt({
      sessionID,
      id: `msg_owned_mcp_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Use the native browser screenshot tool and inspect its image, then finish.",
      delivery: "queue",
      resume: true,
    });
    const state = await observe(
      () => target.control(),
      (state) => {
        if (state.providerRequests > previousRequests && !state.browserTools.length)
          throw new Error(`Native browser tools absent: ${JSON.stringify(state)}`);
        if (state.providerRequests >= previousRequests + 2 && !state.imageRequests)
          throw new Error("The native tool result reached the model without an image");
        return state.imageRequests > 0;
      },
      "Native MCP image did not reach the model",
      30_000,
    );
    expect(state.imageRequests).toBe(1);
    expect(state.browserContextRequests).toBe(1);
    expect(state.browserTools).toHaveLength(buildBrowserToolCatalogue.length);
    expect(calls.filter((method) => method === "tools/call")).toHaveLength(1);
    expect(protectedCalls).toBe(1);
    const messages = await target.client.message.list({ sessionID, limit: 20 });
    const tools = messages.data.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    );
    expect(tools.some((part) => part.name.includes("browser_screenshot"))).toBe(true);
    expect(tools.some((part) => part.name === "shell" || part.name === "read")).toBe(false);
    expect(await readdir(resolve(target.scratch, "project"))).toEqual(filesBefore);
    // No Project config is created, including hidden config subdirectories.
    expect(await Bun.file(resolve(target.scratch, "project/opencode.json")).exists()).toBe(false);
    expect(
      await readFile(resolve(target.scratch, "project/.git/factory-opencode.db")),
    ).toBeTruthy();
    authorized = false;
    const rejected = await fetch(`http://127.0.0.1:${endpoint.port}/fixed`, {
      method: "POST",
      headers: {
        authorization: "Bearer owned-native-mcp-capability",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "after-revocation",
        method: "tools/call",
        params: { name: "browser_screenshot", arguments: {} },
      }),
    });
    expect(rejected.status).toBe(403);
    expect(protectedCalls).toBe(1);
    await target.client.mcp.remove({
      server: "factory_browser",
      location: { directory: "/workspace/project" },
    });
    expect(
      (await target.client.mcp.list({ location: { directory: "/workspace/project" } })).data,
    ).toEqual([]);
  } catch (cause) {
    console.error(
      "Owned native MCP diagnostic",
      JSON.stringify(await target.control()),
      await target.diagnostics(),
    );
    throw cause;
  } finally {
    try {
      await target.dispose();
    } finally {
      await endpoint.stop(true);
    }
  }
}, 120_000);
