import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectSubstrateBrowser,
  type SubstrateBrowserAppSocket,
  type SubstrateBrowserConfiguration,
} from "./substrate-browser-client";

const LoopbackWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): Bun.WebSocket;
};

let directory = "",
  certificate = "",
  key = "",
  credential = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "factory-native-browser-tls-"));
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(join(directory, "key.pem"), pair.privateKey, { mode: 0o600 });
  const command = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-new",
      "-key",
      join(directory, "key.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=atenet-router.ate-system.svc",
      "-addext",
      "subjectAltName=DNS:atenet-router.ate-system.svc",
      "-addext",
      "extendedKeyUsage=serverAuth,clientAuth",
      "-out",
      join(directory, "ca.pem"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await command.exited) !== 0) throw new Error(await new Response(command.stderr).text());
  certificate = await readFile(join(directory, "ca.pem"), "utf8");
  key = await readFile(join(directory, "key.pem"), "utf8");
  credential = join(directory, "credential.pem");
  await writeFile(credential, certificate + key, { mode: 0o600 });
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function scope() {
  const sessionId = crypto.randomUUID();
  return {
    routerURL: "",
    caFile: join(directory, "ca.pem"),
    credentialFile: credential,
    atespace: `fa-${"a".repeat(32)}`,
    actorName: `browser-${sessionId.replaceAll("-", "")}`,
    actorUID: crypto.randomUUID(),
    runtimeAttemptId: crypto.randomUUID(),
    generation: 1,
    scope: {
      sessionId,
      turnId: crypto.randomUUID(),
      agentSessionId: "ses_owned",
      ownerId: "b".repeat(64),
    },
    token: "c".repeat(64),
    apps: ["app"],
  } satisfies SubstrateBrowserConfiguration;
}

function peer(
  config: SubstrateBrowserConfiguration,
  input: {
    helloUID?: string;
    open?: (socket: { send(data: string): void }) => void;
    message?: (frame: any, socket: { send(data: string): void }) => void;
    close?: () => void;
  } = {},
) {
  const frames: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: certificate, key, ca: certificate, requestCert: true, rejectUnauthorized: true },
    fetch(request, server) {
      if (
        request.headers.get("authorization") !== `Bearer ${config.token}` ||
        request.headers.get("x-factory-actor-uid") !== config.actorUID ||
        request.headers.get("x-factory-browser-session") !== config.scope.sessionId ||
        request.headers.get("ate-target-actor") !== `${config.atespace}/${config.actorName}` ||
        new URL(request.url).pathname !== "/internal/factory-browser"
      )
        return new Response(null, { status: 403 });
      if (
        server.upgrade(request, {
          headers: { "sec-websocket-protocol": "factory-native-browser-v1" },
        })
      )
        return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send(
          JSON.stringify({
            type: "browser-connected",
            actorUID: input.helloUID ?? config.actorUID,
            sessionID: config.scope.sessionId,
          }),
        );
        input.open?.(socket);
      },
      message(socket, message) {
        const frame = JSON.parse(String(message));
        frames.push(frame);
        input.message?.(frame, socket);
      },
      close() {
        input.close?.();
      },
    },
  });
  config.routerURL = `wss://127.0.0.1:${server.port}`;
  return { server, frames };
}

const noRelay = {
  openAppSocket: async () => {
    throw new Error("No App WebSocket expected");
  },
  requestApp: async () => {
    throw new Error("No App request expected");
  },
  inspect: async () => {
    throw new Error("No Source read expected");
  },
};

test("native Browser uses built-in Bun mTLS/WS and the public Router's default Actor ingress", async () => {
  const config = scope();
  const target = peer(config, {
    message(frame, socket) {
      if (frame.type === "operation-request")
        socket.send(
          JSON.stringify({
            type: "operation-response",
            operation: {
              type: "operation-response",
              operationId: frame.operation.operationId,
              action: frame.operation.action,
              data: '{"owned":true}',
            },
          }),
        );
    },
  });
  let connection: Awaited<ReturnType<typeof connectSubstrateBrowser>> | undefined;
  try {
    connection = await connectSubstrateBrowser(config, noRelay);
    const operationId = crypto.randomUUID();
    const result = await connection.operation(
      {
        operationId,
        action: "browser-renew",
        runtimeAttemptId: config.runtimeAttemptId,
        generation: 1,
        data: "{}",
      },
      async (send) => {
        expect(target.frames).toHaveLength(0);
        send();
      },
    );
    expect(result.data).toBe('{"owned":true}');
    expect(target.frames).toHaveLength(1);
    expect(target.frames[0].operation.operationId).toBe(operationId);
  } finally {
    connection?.close();
    await target.server.stop(true);
  }
});

test("native Browser rejects a different Actor identity before any operation", async () => {
  const config = scope();
  const target = peer(config, { helloUID: crypto.randomUUID() });
  try {
    await expect(connectSubstrateBrowser(config, noRelay)).rejects.toThrow("invalid");
    expect(target.frames).toHaveLength(0);
  } finally {
    await target.server.stop(true);
  }
});

test("native Browser does not connect before the fresh post-credential-read admission", async () => {
  const config = scope();
  let connections = 0;
  const target = peer(config, {
    open() {
      connections++;
    },
  });
  let connection: Awaited<ReturnType<typeof connectSubstrateBrowser>> | undefined;
  try {
    connection = await connectSubstrateBrowser(config, noRelay, undefined, async (send) => {
      await Bun.sleep(20);
      expect(connections).toBe(0);
      send();
      expect(() => send()).toThrow("already dispatched");
    });
    expect(connections).toBe(1);
  } finally {
    connection?.close();
    await target.server.stop(true);
  }
});

test("refused native Browser connection admission sends no Router handshake", async () => {
  const config = scope();
  let connections = 0;
  const target = peer(config, {
    open() {
      connections++;
    },
  });
  try {
    await expect(
      connectSubstrateBrowser(config, noRelay, undefined, async () => {
        throw new Error("Owned authority ended");
      }),
    ).rejects.toThrow("authority ended");
    expect(connections).toBe(0);
  } finally {
    await target.server.stop(true);
  }
});

test("native Browser callback has exact App/owner scope and preserves streamed cookies", async () => {
  const config = scope();
  const id = crypto.randomUUID();
  const finished = Promise.withResolvers<void>();
  const target = peer(config, {
    open(socket) {
      socket.send(
        JSON.stringify({
          type: "app-request",
          id,
          scope: config.scope,
          app: "app",
          method: "POST",
          path: "/api/counter?mode=owned",
          headers: { Authorization: ["Bearer app-only"], Cookie: ["session=app-only"] },
          data: Buffer.from("owned").toString("base64"),
        }),
      );
    },
    message(frame) {
      if (frame.type === "app-end") finished.resolve();
    },
  });
  let calls = 0;
  const connection = await connectSubstrateBrowser(config, {
    ...noRelay,
    async requestApp(app, request, path) {
      calls++;
      expect(app).toBe("app");
      expect(path).toBe("/api/counter?mode=owned");
      expect(request.headers.get("authorization")).toBe("Bearer app-only");
      expect(request.headers.get("cookie")).toBe("session=app-only");
      expect(await request.text()).toBe("owned");
      return new Response("one original response", {
        headers: [
          ["Set-Cookie", "first=one; Path=/"],
          ["Set-Cookie", "second=two; Expires=Wed, 25 Nov 2026 10:00:00 GMT; Path=/"],
        ],
      });
    },
  });
  try {
    await finished.promise;
    expect(calls).toBe(1);
    expect(target.frames.find((frame) => frame.type === "app-head")?.headers["set-cookie"]).toEqual(
      ["first=one; Path=/", "second=two; Expires=Wed, 25 Nov 2026 10:00:00 GMT; Path=/"],
    );
    expect(
      Buffer.concat(
        target.frames
          .filter((frame) => frame.type === "app-data")
          .map((frame) => Buffer.from(frame.data, "base64")),
      ).toString(),
    ).toBe("one original response");
  } finally {
    connection.close();
    await target.server.stop(true);
  }
});

test("native Browser Source callbacks survive repeated mixed App traffic without replay", async () => {
  const config = scope();
  const rounds = 64;
  const expected = new Map<string, unknown>();
  const received = new Map<string, unknown>();
  const finished = Promise.withResolvers<void>();
  const batchDone = new Map<string, () => void>();
  const operationId = crypto.randomUUID();
  let index = 0;
  const target = peer(config, {
    message(frame, socket) {
      if (frame.type === "operation-request") {
        const drive = async () => {
          for (let round = 0; round < rounds; round++) {
            const batch: Promise<void>[] = [];
            for (let member = 0; member < 4; member++) {
              const id = crypto.randomUUID();
              expected.set(id, {
                ...config.scope,
                app: "app",
                headCommit: (index++).toString(16).padStart(40, "0"),
              });
              batch.push(new Promise((resolve) => batchDone.set(id, resolve)));
              socket.send(
                JSON.stringify({ type: "inspection-request", id, scope: config.scope, app: "app" }),
              );
              socket.send(
                JSON.stringify({
                  type: "app-request",
                  id: crypto.randomUUID(),
                  scope: config.scope,
                  app: "app",
                  method: "GET",
                  path: "/app.js",
                }),
              );
            }
            await Promise.all(batch);
          }
          socket.send(
            JSON.stringify({
              type: "operation-response",
              operation: {
                type: "operation-response",
                operationId,
                action: "browser-call",
                data: "{}",
              },
            }),
          );
        };
        void drive().catch(finished.reject);
      } else if (frame.type === "inspection-context") {
        expect(received.has(frame.id)).toBe(false);
        received.set(frame.id, frame.context);
        batchDone.get(frame.id)?.();
        if (received.size === rounds * 4) finished.resolve();
      }
      if (frame.type === "relay-error") finished.reject(new Error("Source callback was lost"));
    },
    close() {
      if (received.size !== rounds * 4)
        finished.reject(new Error("Source callback was lost when the wire closed"));
    },
  });
  let inspections = 0;
  const connection = await connectSubstrateBrowser(
    config,
    {
      ...noRelay,
      async inspect(app, signal) {
        expect(app).toBe("app");
        signal.throwIfAborted();
        // Resolve out of order across the same WebSocket; HTTP callbacks share it.
        const index = inspections++;
        await Bun.sleep(index % 3);
        signal.throwIfAborted();
        return { ...config.scope, app, headCommit: index.toString(16).padStart(40, "0") };
      },
      async requestApp() {
        return new Response("owned");
      },
    },
    AbortSignal.timeout(2500),
  );
  try {
    await Promise.all([
      connection.operation(
        {
          operationId,
          action: "browser-call",
          runtimeAttemptId: config.runtimeAttemptId,
          generation: 1,
          data: "{}",
        },
        async (send) => send(),
      ),
      finished.promise,
    ]);
    expect(inspections).toBe(rounds * 4);
    expect(received).toEqual(expected);
  } finally {
    connection.close();
    await target.server.stop(true);
  }
});

test("native Browser Source callback failure stays scoped and is never retried", async () => {
  const config = scope();
  const requestIDs: string[] = [];
  let operation: { operationId: string; action: string } | undefined;
  const target = peer(config, {
    message(frame, socket) {
      if (frame.type === "operation-request") {
        operation = frame.operation;
        const id = crypto.randomUUID();
        requestIDs.push(id);
        socket.send(
          JSON.stringify({ type: "inspection-request", id, scope: config.scope, app: "app" }),
        );
      } else if (["relay-error", "inspection-context"].includes(frame.type)) {
        if (!operation) throw new Error("No Source operation was dispatched");
        socket.send(
          JSON.stringify({
            type: "operation-response",
            operation: {
              type: "operation-response",
              operationId: operation.operationId,
              action: operation.action,
              ...(frame.type === "relay-error"
                ? { error: "native Browser Source context is unavailable" }
                : { data: JSON.stringify(frame.context) }),
            },
          }),
        );
      }
    },
  });
  let calls = 0;
  const connection = await connectSubstrateBrowser(
    config,
    {
      ...noRelay,
      async inspect() {
        if (++calls === 1) throw new Error("private Source credential and diagnostic");
        return { headCommit: "d".repeat(40) };
      },
    },
    AbortSignal.timeout(2500),
  );
  const run = () =>
    connection.operation(
      {
        operationId: crypto.randomUUID(),
        action: "browser-call",
        runtimeAttemptId: config.runtimeAttemptId,
        generation: 1,
        data: "{}",
      },
      async (send) => send(),
    );
  try {
    await expect(run()).rejects.toThrow("native Browser Source context is unavailable");
    expect(await run()).toEqual({ data: JSON.stringify({ headCommit: "d".repeat(40) }) });
    expect(calls).toBe(2);
    expect(target.frames.filter((frame) => frame.type === "relay-error")).toEqual([
      { type: "relay-error", id: requestIDs[0] },
    ]);
    expect(target.frames.filter((frame) => frame.type === "inspection-context")).toEqual([
      { type: "inspection-context", id: requestIDs[1], context: { headCommit: "d".repeat(40) } },
    ]);
  } finally {
    connection.close();
    await target.server.stop(true);
  }
});

test("native Browser releases cancelled App streams while Source replies remain deliverable", async () => {
  const config = scope();
  const rounds = 64;
  const sourceDone = new Map<string, () => void>();
  const appDone = new Map<string, () => void>();
  let appRequests = 0;
  let cancelled = 0;
  let inspected = 0;
  const target = peer(config, {
    message(frame, socket) {
      if (frame.type === "operation-request") {
        const operation: { operationId: string; action: string } = frame.operation;
        const drive = async () => {
          for (let round = 0; round < rounds; round++) {
            const appID = crypto.randomUUID();
            const sourceID = crypto.randomUUID();
            const app = new Promise<void>((resolve) => appDone.set(appID, resolve));
            const source = new Promise<void>((resolve) => sourceDone.set(sourceID, resolve));
            socket.send(
              JSON.stringify({
                type: "app-request",
                id: appID,
                scope: config.scope,
                app: "app",
                method: "GET",
                path: "/events",
              }),
            );
            await app;
            socket.send(JSON.stringify({ type: "relay-cancel", id: appID }));
            socket.send(
              JSON.stringify({
                type: "inspection-request",
                id: sourceID,
                scope: config.scope,
                app: "app",
              }),
            );
            await source;
          }
          socket.send(
            JSON.stringify({
              type: "operation-response",
              operation: {
                type: "operation-response",
                operationId: operation.operationId,
                action: operation.action,
                data: "{}",
              },
            }),
          );
        };
        void drive();
      } else if (frame.type === "app-head") {
        appDone.get(frame.id)?.();
      } else if (frame.type === "inspection-context") {
        sourceDone.get(frame.id)?.();
      }
    },
  });
  const connection = await connectSubstrateBrowser(
    config,
    {
      ...noRelay,
      async inspect(_app, signal) {
        signal.throwIfAborted();
        inspected++;
        return { headCommit: "e".repeat(40) };
      },
      async requestApp() {
        appRequests++;
        return new Response(
          new ReadableStream({
            // A stream with no next chunk models an idle App subscription.
            cancel() {
              cancelled++;
            },
          }),
        );
      },
    },
    AbortSignal.timeout(2500),
  );
  try {
    await connection.operation(
      {
        operationId: crypto.randomUUID(),
        action: "browser-call",
        runtimeAttemptId: config.runtimeAttemptId,
        generation: 1,
        data: "{}",
      },
      async (send) => send(),
    );
    expect(appRequests).toBe(rounds);
    expect(cancelled).toBe(rounds);
    expect(inspected).toBe(rounds);
    expect(target.frames.filter((frame) => frame.type === "inspection-context")).toHaveLength(
      rounds,
    );
    expect(
      target.frames.filter((frame) => ["relay-error", "app-end"].includes(frame.type)),
    ).toEqual([]);
  } finally {
    connection.close();
    await target.server.stop(true);
  }
});

for (const ended of ["request", "connection"] as const) {
  test(`native Browser discards a late Source reply after ${ended} cancellation`, async () => {
    const config = scope();
    const id = crypto.randomUUID();
    const entered = Promise.withResolvers<AbortSignal>();
    const reply = Promise.withResolvers<unknown>();
    let remote: { send(data: string): void } | undefined;
    const target = peer(config, {
      message(frame, socket) {
        if (frame.type !== "operation-request") return;
        remote = socket;
        socket.send(
          JSON.stringify({ type: "inspection-request", id, scope: config.scope, app: "app" }),
        );
      },
    });
    const connection = await connectSubstrateBrowser(
      config,
      {
        ...noRelay,
        async inspect(_app, signal) {
          entered.resolve(signal);
          return reply.promise;
        },
      },
      AbortSignal.timeout(2500),
    );
    const operation = connection.operation(
      {
        operationId: crypto.randomUUID(),
        action: "browser-call",
        runtimeAttemptId: config.runtimeAttemptId,
        generation: 1,
        data: "{}",
      },
      async (send) => send(),
    );
    void operation.catch(() => {});
    try {
      const signal = await entered.promise;
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      if (ended === "request") remote?.send(JSON.stringify({ type: "relay-cancel", id }));
      else connection.close();
      await aborted;
      reply.resolve({ headCommit: "f".repeat(40) });
      // Join the callback continuation before inspecting the already open wire.
      await Bun.sleep(0);
      expect(target.frames.filter((frame) => frame.id === id)).toEqual([]);
      connection.close();
      await expect(operation).rejects.toThrow("ended");
    } finally {
      reply.resolve(undefined);
      connection.close();
      await target.server.stop(true);
    }
  });
}

test("native Browser carries text, binary and empty App WebSocket frames over the mTLS relay", async () => {
  const config = scope();
  const id = crypto.randomUUID();
  const received = Promise.withResolvers<void>();
  const frames: any[] = [];
  let remote: { send(data: string): void } | undefined;
  const target = peer(config, {
    open(socket) {
      remote = socket;
      socket.send(
        JSON.stringify({
          type: "app-socket-open",
          id,
          app: "app",
          scope: config.scope,
          path: "/hmr?q=original",
          headers: {
            Authorization: ["Bearer isolated-app"],
            Cookie: ["app_session=owned"],
            "Sec-WebSocket-Protocol": ["owned-hmr"],
          },
        }),
      );
    },
    message(frame, socket) {
      frames.push(frame);
      if (frame.type === "app-socket-ready")
        for (const [messageType, data] of [
          [1, "original"],
          [2, Buffer.from([0, 255, 4])],
          [1, ""],
        ] as const)
          socket.send(
            JSON.stringify({
              type: "app-socket-message",
              id,
              scope: config.scope,
              messageType,
              data: Buffer.from(data).toString("base64"),
            }),
          );
      if (frames.filter((value) => value.type === "app-socket-message").length === 3)
        received.resolve();
    },
  });
  let cancelled = 0;
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      expect(new URL(request.url).pathname + new URL(request.url).search).toBe("/hmr?q=original");
      expect(request.headers.get("cookie")).toBe("app_session=owned");
      expect(request.headers.get("authorization")).toBe("Bearer isolated-app");
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "owned-hmr" } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
      close() {
        cancelled++;
      },
    },
  });
  const upstreams: Bun.WebSocket[] = [];
  const connection = await connectSubstrateBrowser(
    config,
    {
      ...noRelay,
      async openAppSocket(appName, request, path): Promise<SubstrateBrowserAppSocket> {
        expect(appName).toBe("app");
        const ws = new LoopbackWebSocket(`ws://127.0.0.1:${app.port}${path}`, {
          protocols: ["owned-hmr"],
          headers: request.headers,
        });
        upstreams.push(ws);
        ws.binaryType = "arraybuffer";
        const opened = Promise.withResolvers<void>();
        const messages = new ReadableStream<{ messageType: 1 | 2; data: Uint8Array }>({
          start(controller) {
            ws.addEventListener("message", (event) =>
              controller.enqueue({
                messageType: typeof event.data === "string" ? 1 : 2,
                data: Buffer.from(event.data),
              }),
            );
          },
        });
        ws.addEventListener("open", () => opened.resolve());
        await opened.promise;
        return {
          protocol: ws.protocol,
          messages,
          async send(messageType, data) {
            request.signal.throwIfAborted();
            ws.send(messageType === 1 ? Buffer.from(data).toString() : data);
          },
          close() {
            ws.close();
          },
        };
      },
    },
    AbortSignal.timeout(2500),
  );
  try {
    await received.promise;
    expect(
      frames
        .filter((frame) => frame.type === "app-socket-message")
        .map(({ messageType, data }) => ({ messageType, data })),
    ).toEqual([
      { messageType: 1, data: Buffer.from("original").toString("base64") },
      { messageType: 2, data: "AP8E" },
      { messageType: 1, data: "" },
    ]);
    remote?.send(JSON.stringify({ type: "relay-cancel", id }));
    while (!cancelled) await Bun.sleep(1);
    expect(frames.filter((frame) => frame.type === "relay-error")).toEqual([]);
    expect(upstreams).toHaveLength(1);
  } finally {
    connection.close();
    for (const socket of upstreams) socket.close();
    await target.server.stop(true);
    await app.stop(true);
  }
});

for (const changed of ["scope", "app", "path", "replay"] as const) {
  test(`native Browser refuses a WebSocket ${changed} change without reconnect/replay`, async () => {
    const config = scope();
    const id = crypto.randomUUID();
    let remote: { send(data: string): void } | undefined;
    let calls = 0;
    let connections = 0;
    const closed = Promise.withResolvers<void>();
    const target = peer(config, {
      open(socket) {
        remote = socket;
        connections++;
      },
      close() {
        closed.resolve();
      },
    });
    const connection = await connectSubstrateBrowser(
      config,
      {
        ...noRelay,
        async openAppSocket() {
          calls++;
          return {
            protocol: "",
            messages: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            async send() {},
            close() {},
          };
        },
      },
      AbortSignal.timeout(2500),
    );
    try {
      const frame = {
        type: "app-socket-open",
        id,
        app: changed === "app" ? "source" : "app",
        scope:
          changed === "scope" ? { ...config.scope, turnId: crypto.randomUUID() } : config.scope,
        path: changed === "path" ? "//foreign.test/" : "/hmr",
      };
      remote!.send(JSON.stringify(frame));
      if (changed === "replay") {
        while (!target.frames.some((value) => value.type === "app-socket-close"))
          await Bun.sleep(1);
        remote!.send(JSON.stringify(frame));
      }
      if (changed === "path") {
        while (!target.frames.some((value) => value.type === "relay-error")) await Bun.sleep(1);
      } else await closed.promise;
      expect(calls).toBe(changed === "replay" ? 1 : 0);
      expect(connections).toBe(1);
      expect(JSON.stringify(target.frames)).not.toContain(config.token);
    } finally {
      connection.close();
      await target.server.stop(true);
    }
  });
}

for (const ended of [
  "cancel",
  "connection",
  "changed-scope",
  "denied-send",
  "input-bound",
  "output-bound",
] as const) {
  test(`native Browser WebSocket ${ended} ends its original stream and sanitizes errors`, async () => {
    const config = scope();
    const id = crypto.randomUUID();
    let remote: { send(data: string): void } | undefined;
    let output!: ReadableStreamDefaultController<{ messageType: 1 | 2; data: Uint8Array }>;
    const closed = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    let sends = 0,
      closes = 0;
    const held = Promise.withResolvers<void>();
    const target = peer(config, {
      open(socket) {
        remote = socket;
        socket.send(
          JSON.stringify({
            type: "app-socket-open",
            id,
            app: "app",
            scope: config.scope,
            path: "/",
          }),
        );
      },
      message(frame) {
        if (frame.type === "relay-error") failed.resolve();
      },
    });
    const connection = await connectSubstrateBrowser(
      config,
      {
        ...noRelay,
        async openAppSocket() {
          return {
            protocol: "",
            messages: new ReadableStream({
              start(controller) {
                output = controller;
              },
            }),
            async send() {
              if (ended === "input-bound") await held.promise;
              sends++;
              if (ended === "denied-send") throw new Error("private App token");
            },
            close() {
              closes++;
              closed.resolve();
            },
          };
        },
      },
      AbortSignal.timeout(2500),
    );
    try {
      while (!target.frames.some((frame) => frame.type === "app-socket-ready")) await Bun.sleep(1);
      const frame = {
        type: "app-socket-message",
        id,
        scope: config.scope,
        messageType: 1,
        data: "eA==",
      };
      if (ended === "cancel") remote!.send(JSON.stringify({ type: "relay-cancel", id }));
      if (ended === "connection") connection.close();
      if (ended === "changed-scope")
        remote!.send(
          JSON.stringify({ ...frame, scope: { ...config.scope, ownerId: "f".repeat(64) } }),
        );
      if (ended === "denied-send") remote!.send(JSON.stringify(frame));
      if (ended === "input-bound")
        for (let count = 0; count < 17; count++) remote!.send(JSON.stringify(frame));
      if (ended === "output-bound")
        output.enqueue({ messageType: 2, data: new Uint8Array((64 << 10) + 1) });
      await closed.promise;
      held.resolve();
      if (ended === "denied-send" || ended.endsWith("bound")) await failed.promise;
      expect(closes).toBeGreaterThan(0);
      expect(sends).toBeLessThanOrEqual(1);
      expect(JSON.stringify(target.frames)).not.toContain("private");
      if (ended === "denied-send" || ended.endsWith("bound"))
        expect(target.frames.filter((frame) => frame.type === "relay-error")).toHaveLength(1);
      expect(target.frames.filter((frame) => frame.type === "app-socket-message")).toEqual([]);
    } finally {
      held.resolve();
      connection.close();
      await target.server.stop(true);
    }
  });
}
