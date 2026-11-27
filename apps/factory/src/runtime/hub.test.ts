import { describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  appRuntimeHeaders,
  appRuntimeSocketContext,
  RuntimeHub,
  type RuntimeSocketData,
  safeRuntimeHeaders,
  scopeAppCookies,
  scopeTheiaConnectionCookie,
  theiaConnectionToken,
} from "./hub";

const LoopbackWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): Bun.WebSocket;
};

test("isolated App cookies cover that App's origin without planting Factory credentials", () => {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    "app_session=owned; Domain=foreign.example; Path=/private; HttpOnly",
  );
  headers.append("set-cookie", "factory_runtime_access=forged; Path=/");
  const scoped = scopeAppCookies(
    new Response(null, { headers }),
    "/runtime/01994a7d-0000-7000-8000-000000000001/preview/app-forms",
    true,
  );
  expect(scoped.headers.getSetCookie()).toEqual([
    "app_session=owned; HttpOnly; Path=/; SameSite=None; Secure; Partitioned",
  ]);
});

function connectorSocket(role: "parent" | "child") {
  return {
    data: { kind: "connector", role, attemptID: "attempt", generation: 1 },
    close() {},
    send() {
      return 1;
    },
    getBufferedAmount() {
      return 0;
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
}

function nativeAppSocketFixture() {
  const hub = new RuntimeHub(async () => {});
  const child = connectorSocket("child");
  const sent: any[] = [];
  child.send = ((raw: string) => {
    sent.push(JSON.parse(raw));
    return 1;
  }) as typeof child.send;
  hub.allow("attempt", 1, "parent", "child", "original-actor");
  hub.open(child);
  const hello = (target = "http://127.0.0.1:3000") =>
    hub.message(
      child,
      JSON.stringify({
        type: "hello",
        role: "child",
        channels: [{ name: "app", kind: "app", target }],
      }),
    );
  hello();
  const identity = { generation: 1, actorUID: "original-actor", target: "http://127.0.0.1:3000" };
  const abort = new AbortController();
  const open = (admit = async (send: () => void) => send(), headers?: HeadersInit) =>
    hub.openBrowserAppSocket(
      "attempt",
      "app",
      new Request("http://browser.internal/events?owned=1", {
        signal: abort.signal,
        ...(headers ? { headers } : {}),
      }),
      "/events?owned=1",
      identity,
      admit,
    );
  const ready = () => {
    const streamId = sent.find((frame) => frame.type === "websocket-open")?.streamId;
    hub.message(child, JSON.stringify({ type: "websocket-ready", streamId }));
    return streamId as string;
  };
  return { hub, child, sent, hello, identity, abort, open, ready };
}

describe("native Browser App WebSocket authority", () => {
  test.each(["denied", "actor", "generation", "target", "child", "cancel", "stop", "suspend"])(
    "a held opening cannot dispatch after %s",
    async (ended) => {
      const f = nativeAppSocketFixture();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const opened = f.open(
        async (send) => {
          entered.resolve();
          await gate.promise;
          if (ended === "denied") throw new Error("private authority diagnostic");
          send();
        },
        { authorization: "Bearer isolated-app" },
      );
      void opened.catch(() => {});
      try {
        await entered.promise;
        if (ended === "actor") f.hub.allow("attempt", 1, "parent", "child", "other-actor");
        if (ended === "generation") f.hub.allow("attempt", 2, "parent", "child", "original-actor");
        if (ended === "target") f.hello("http://127.0.0.1:3999");
        if (ended === "child") {
          f.hub.close(f.child);
          f.hub.open(connectorSocket("child"));
        }
        if (ended === "cancel") f.abort.abort();
        if (ended === "stop") f.hub.stop("attempt");
        if (ended === "suspend") f.hub.suspend("attempt");
        gate.resolve();
        await expect(opened).rejects.toThrow();
        expect(f.sent.filter((frame) => frame.type === "websocket-open")).toEqual([]);
      } finally {
        gate.resolve();
        f.hub.revoke("attempt");
      }
    },
  );

  test("every data send rechecks current authority and copies data before waiting", async () => {
    const f = nativeAppSocketFixture();
    let checks = 0;
    let permit = true;
    const opened = f.open(async (send) => {
      checks++;
      await Bun.sleep(0);
      if (!permit) throw new Error("private revoked credential");
      send();
    });
    await Bun.sleep(0);
    // Opening admission includes one async turn.
    while (!f.sent.some((frame) => frame.type === "websocket-open")) await Bun.sleep(1);
    const streamId = f.ready();
    try {
      const socket = await opened;
      const data = Buffer.from([0, 255, 2]);
      const send = socket.send(2, data);
      data.fill(9);
      await send;
      expect(f.sent.at(-1)).toMatchObject({
        type: "websocket-message",
        streamId,
        messageType: 2,
        data: "AP8C",
      });
      permit = false;
      await expect(socket.send(1, Buffer.from("denied"))).rejects.toThrow();
      expect(checks).toBe(3);
      expect(f.sent.filter((frame) => frame.type === "websocket-message")).toHaveLength(1);
      expect(JSON.stringify(f.sent)).not.toContain("private");
      expect(f.hub.attended("attempt")).toBe(false);
    } finally {
      f.hub.revoke("attempt");
    }
  });

  test.each(["actor", "generation", "target", "child", "cancel", "stop", "suspend"])(
    "a held data send cannot outlive its original %s authority",
    async (ended) => {
      const f = nativeAppSocketFixture();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let checks = 0;
      const opened = f.open(
        async (send) => {
          if (++checks > 1) {
            entered.resolve();
            await release.promise;
          }
          send();
        },
        { authorization: "Bearer isolated-app" },
      );
      f.ready();
      try {
        const socket = await opened;
        const sending = socket.send(1, Buffer.from("never replay"));
        void sending.catch(() => {});
        await entered.promise;
        if (ended === "actor") f.hub.allow("attempt", 1, "parent", "child", "other-actor");
        if (ended === "generation") f.hub.allow("attempt", 2, "parent", "child", "original-actor");
        if (ended === "target") f.hello("http://127.0.0.1:3999");
        if (ended === "child") {
          f.hub.close(f.child);
          f.hub.open(connectorSocket("child"));
        }
        if (ended === "cancel") f.abort.abort();
        if (ended === "stop") f.hub.stop("attempt");
        if (ended === "suspend") f.hub.suspend("attempt");
        release.resolve();
        await expect(sending).rejects.toThrow();
        expect(f.sent.filter((frame) => frame.type === "websocket-message")).toEqual([]);
        expect(f.hub.attended("attempt")).toBe(false);
      } finally {
        release.resolve();
        f.hub.revoke("attempt");
      }
    },
  );

  test("observing the same immutable Actor authority does not disrupt an open App socket", async () => {
    const f = nativeAppSocketFixture();
    const opened = f.open();
    f.ready();
    try {
      const socket = await opened;
      f.hub.allow("attempt", 1, "parent", "child", "original-actor");
      await socket.send(1, Buffer.from("same authority"));
      expect(f.sent.at(-1)?.type).toBe("websocket-message");
      socket.close();
    } finally {
      f.hub.revoke("attempt");
    }
  });

  test.each(["frame", "queue", "backpressure", "dropped"])("bounds %s input", async (bound) => {
    const f = nativeAppSocketFixture();
    const gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let checks = 0;
    const opened = f.open(async (send) => {
      if (++checks > 1 && bound === "queue") {
        entered.resolve();
        await gate.promise;
      }
      send();
    });
    f.ready();
    try {
      const socket = await opened;
      if (bound === "backpressure") f.child.getBufferedAmount = () => (1 << 20) + 1;
      if (bound === "dropped") f.child.send = () => 0;
      const sending = socket.send(2, Buffer.alloc(bound === "frame" ? (64 << 10) + 1 : 0));
      void sending.catch(() => {});
      if (bound === "queue") {
        await entered.promise;
        const queued = Array.from({ length: 16 }, () => socket.send(1, Buffer.from("queued")));
        for (const promise of queued) void promise.catch(() => {});
        gate.resolve();
        expect(
          (await Promise.allSettled([sending, ...queued])).every(
            (result) => result.status === "rejected",
          ),
        ).toBe(true);
      } else await expect(sending).rejects.toThrow();
      expect(f.sent.filter((frame) => frame.type === "websocket-message")).toEqual([]);
      socket.close();
    } finally {
      gate.resolve();
      f.hub.revoke("attempt");
    }
  });

  test.each([
    ["app-only", "Bearer isolated-app"],
    ["byte-limit", `Bearer ${"x".repeat((16 << 10) - 7)}`],
    ["multibyte-limit", `Basic ${"é".repeat(((16 << 10) - 6) / 2)}`],
  ])(
    "separates bounded %s App Authorization from generic WebSocket headers",
    async (_name, authorization) => {
      const f = nativeAppSocketFixture();
      try {
        const opening = f.open(undefined, {
          authorization,
          cookie: "app_session=owned",
          "x-app": "ordinary",
          "x-factory-parent-token": "parent-only-capability",
          "proxy-authorization": "Bearer factory-only",
          "ate-target-actor": "foreign/actor",
        });
        f.ready();
        const socket = await opening;
        const frame = f.sent.find((value) => value.type === "websocket-open");
        expect(frame?.appAuthorization).toBe(authorization);
        expect(frame?.headers).toEqual({ cookie: "app_session=owned", "x-app": "ordinary" });
        await socket.send(1, Buffer.from("owned"));
        expect(f.sent.at(-1)).not.toHaveProperty("appAuthorization");
        expect(JSON.stringify(f.sent)).not.toContain("parent-only-capability");
        expect(JSON.stringify(f.sent)).not.toContain("factory-only");
        socket.close();
      } finally {
        f.hub.revoke("attempt");
      }
    },
  );

  test.each([
    { authorization: `Bearer ${"x".repeat(16 << 10)}` },
    { authorization: `Basic ${"é".repeat(8 << 10)}` },
    { authorization: "Bearer isolated-app\r\nX-Injected: owned" },
    { authorization: "Bearer isolated\tapp" },
    { "sec-websocket-protocol": "invalid protocol" },
  ])("rejects invalid handshake credentials/protocols without dispatch", async (headers) => {
    const f = nativeAppSocketFixture();
    try {
      await expect(Promise.resolve().then(() => f.open(undefined, headers))).rejects.toThrow();
      expect(f.sent).toEqual([]);
    } finally {
      f.hub.revoke("attempt");
    }
  });

  test("public App WebSockets still cannot forward Factory authorization through the App-only field", () => {
    const f = nativeAppSocketFixture();
    const attemptID = "01994a7d-0000-7000-8000-000000000001";
    const path = "/hmr";
    const context = appRuntimeSocketContext(
      new Request(`https://factory.test/runtime/${attemptID}/app${path}`, {
        headers: {
          authorization: "Bearer factory-private",
          cookie: "factory.session_token=factory-cookie; app_session=owned",
          "sec-websocket-protocol": "owned-hmr",
        },
      }),
      path,
    );
    const browser = {
      data: { kind: "browser", attemptID: "attempt", channel: "app", path, ...context },
      send: () => 1,
      close() {},
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    try {
      f.hub.open(browser);
      const frame = f.sent.find((value) => value.type === "websocket-open");
      expect(frame).not.toHaveProperty("appAuthorization");
      expect(frame?.headers).not.toHaveProperty("authorization");
      expect(JSON.stringify(frame)).not.toContain("factory-private");
      expect(JSON.stringify(frame)).not.toContain("factory-cookie");
    } finally {
      f.hub.revoke("attempt");
    }
  });

  test.each(["frame", "queue", "total", "invalid-type"])("bounds %s output", async (bound) => {
    const f = nativeAppSocketFixture();
    const opened = f.open();
    const streamId = f.ready();
    try {
      const socket = await opened;
      const count = bound === "queue" ? 17 : bound === "total" ? 257 : 1;
      const data = Buffer.alloc(
        bound === "frame" ? (64 << 10) + 1 : bound === "total" ? 64 << 10 : 0,
      );
      const reader = socket.messages.getReader();
      for (let index = 0; index < count; index++) {
        f.hub.message(
          f.child,
          JSON.stringify({
            type: "websocket-message",
            streamId,
            messageType: bound === "invalid-type" ? 3 : 2,
            data: data.toString("base64"),
          }),
        );
        if (bound === "total" && index < 256) await reader.read();
      }
      await expect(reader.read()).rejects.toThrow("output");
      expect(f.sent.at(-1)).toMatchObject({ type: "stream-close", streamId });
      expect(f.hub.attended("attempt")).toBe(false);
    } finally {
      f.hub.revoke("attempt");
    }
  });

  test.each(["source", "ide", "app-undeclared"])("cannot upgrade %s", async (channel) => {
    const f = nativeAppSocketFixture();
    try {
      await expect(
        f.hub.openBrowserAppSocket(
          "attempt",
          channel,
          new Request("http://browser.internal/", {
            headers: { authorization: "Bearer isolated-app" },
          }),
          "/",
          f.identity,
          async (send) => send(),
        ),
      ).rejects.toThrow("declared App");
      expect(f.sent).toEqual([]);
    } finally {
      f.hub.revoke("attempt");
    }
  });
});

test("native Browser App uses real loopback WebSockets with the existing Child wire protocol", async () => {
  const hub = new RuntimeHub(async () => {});
  const actorUID = crypto.randomUUID();
  hub.allow("attempt", 1, "parent", "child", actorUID);
  const echoed: Array<string | Buffer> = [];
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      expect(new URL(request.url).pathname).toBe("/hmr");
      expect(request.headers.get("cookie")).toBe("app_session=owned");
      expect(request.headers.get("authorization")).toBe("Bearer isolated-app");
      expect(request.headers.get("x-factory-token")).toBeNull();
      expect(request.headers.get("ate-target-actor")).toBeNull();
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "owned-hmr" } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        echoed.push(message);
        socket.send(message);
      },
    },
  });
  const connected = Promise.withResolvers<void>();
  const bridge = Bun.serve<RuntimeSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { kind: "connector", role: "child", attemptID: "attempt", generation: 1 },
        })
      )
        return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        hub.open(socket);
      },
      message(socket, message) {
        hub.message(socket, message);
        if (JSON.parse(String(message)).type === "hello") connected.resolve();
      },
      close(socket) {
        hub.close(socket);
      },
    },
  });
  const child = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const apps = new Map<string, Bun.WebSocket>();
  child.addEventListener("open", () =>
    child.send(
      JSON.stringify({
        type: "hello",
        role: "child",
        channels: [{ name: "app", kind: "app", target: `http://127.0.0.1:${app.port}` }],
      }),
    ),
  );
  child.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "websocket-open") {
      expect(frame.headers).not.toHaveProperty("authorization");
      const upstream = new LoopbackWebSocket(`ws://127.0.0.1:${app.port}${frame.path}`, {
        protocols: [frame.protocol],
        headers: {
          ...frame.headers,
          ...(frame.appAuthorization ? { authorization: frame.appAuthorization } : {}),
        },
      });
      upstream.binaryType = "arraybuffer";
      apps.set(frame.streamId, upstream);
      upstream.addEventListener("open", () =>
        child.send(
          JSON.stringify({
            type: "websocket-ready",
            streamId: frame.streamId,
            protocol: upstream.protocol,
          }),
        ),
      );
      upstream.addEventListener("message", (event) =>
        child.send(
          JSON.stringify({
            type: "websocket-message",
            streamId: frame.streamId,
            messageType: typeof event.data === "string" ? 1 : 2,
            data: Buffer.from(event.data).toString("base64"),
          }),
        ),
      );
    } else if (frame.type === "websocket-message") {
      const data = Buffer.from(frame.data, "base64");
      apps.get(frame.streamId)?.send(frame.messageType === 1 ? data.toString() : data);
    } else if (frame.type === "stream-close") {
      apps.get(frame.streamId)?.close();
      apps.delete(frame.streamId);
    }
  });
  try {
    await connected.promise;
    const socket = await hub.openBrowserAppSocket(
      "attempt",
      "app",
      new Request("http://browser.internal/hmr", {
        headers: {
          authorization: "Bearer isolated-app",
          cookie: "app_session=owned",
          "sec-websocket-protocol": "owned-hmr",
          "x-factory-token": "must-not-forward",
          "ate-target-actor": "foreign/actor",
        },
      }),
      "/hmr",
      { actorUID, generation: 1, target: `http://127.0.0.1:${app.port}` },
      async (send) => send(),
    );
    expect(socket.protocol).toBe("owned-hmr");
    const reader = socket.messages.getReader();
    for (const [messageType, data] of [
      [1, Buffer.from("hmr")],
      [2, Buffer.from([0, 255, 3])],
      [1, Buffer.alloc(0)],
    ] as const) {
      await socket.send(messageType, data);
      const result = await reader.read();
      expect(result.value?.messageType).toBe(messageType);
      expect(Buffer.from(result.value!.data)).toEqual(data);
    }
    expect(echoed).toHaveLength(3);
    hub.stop("attempt");
    await expect(reader.read()).rejects.toThrow("authority ended");
    await expect(socket.send(1, Buffer.from("late"))).rejects.toThrow();
    expect(echoed).toHaveLength(3);
  } finally {
    hub.revoke("attempt");
    child.close();
    for (const socket of apps.values()) socket.close();
    await bridge.stop(true);
    await app.stop(true);
  }
});

test.each([
  ["source", "http://source.internal", "checkpoint", 120_000],
  ["source", "http://source.internal", "chunk", 120_000],
  ["source", "https://factory.test", "checkpoint", 60_000],
  ["source", "http://source.internal", "read", 60_000],
  ["agent", "http://source.internal", "checkpoint", 60_000],
] as const)(
  "only internal Source handoff HTTP receives its caller's first-response budget: %s %s %s",
  async (channel, origin, operation, milliseconds) => {
    const hub = new RuntimeHub(async () => {});
    const parent = connectorSocket("parent");
    const child = connectorSocket("child");
    const sent = Promise.withResolvers<string>();
    const send = (raw: string) => {
      const frame = JSON.parse(raw);
      if (frame.type === "http-request") sent.resolve(frame.streamId);
      return 1;
    };
    parent.send = child.send = send as typeof parent.send;
    hub.open(parent);
    hub.message(
      parent,
      JSON.stringify({
        type: "hello",
        role: "parent",
        channels: [{ name: "source", kind: "source" }],
      }),
    );
    hub.open(child);
    const timer = spyOn(globalThis, "setTimeout");
    try {
      const response = hub.request(
        "attempt",
        channel,
        new Request(origin, { method: "POST", body: "{}" }),
        `/v1/workspaces/01994a7d-0000-7000-8000-000000000001/${operation}`,
      );
      const streamId = await sent.promise;
      const deadline = timer.mock.calls.at(-1)?.[1];
      const socket = channel === "source" ? parent : child;
      hub.message(socket, JSON.stringify({ type: "http-response", streamId, status: 200 }));
      hub.message(socket, JSON.stringify({ type: "stream-end", streamId }));
      expect(await (await response).text()).toBe("");
      expect(deadline).toBe(milliseconds);
    } finally {
      timer.mockRestore();
      hub.revoke("attempt");
    }
  },
);

test.each([true, false])(
  "failed Parent preserves only its advertised Source/checkpoint protocol, advertised=%s",
  async (advertised) => {
    const hub = new RuntimeHub(async () => {});
    const parent = connectorSocket("parent");
    const frames: Array<Record<string, string>> = [];
    parent.send = ((text: string) => {
      frames.push(JSON.parse(text));
      return 1;
    }) as typeof parent.send;
    hub.open(parent);
    hub.message(
      parent,
      JSON.stringify({
        type: "hello",
        role: "parent",
        channels: advertised ? [{ name: "source", kind: "source" }] : [],
      }),
    );
    hub.message(
      parent,
      JSON.stringify({ type: "status", phase: "failed", error: "original bootstrap failed" }),
    );
    try {
      expect(hub.ready("attempt")).toBe(false);
      expect(hub.sourceConnected("attempt")).toBe(advertised);
      for (const action of ["workspace-git", "browser-open", "skills-install"])
        await expect(
          hub.parentOperation("attempt", { operationId: action, action }),
        ).rejects.toThrow("only retained Source");
      if (advertised) {
        const drain = hub.parentOperation("attempt", {
          operationId: "recorded-drain",
          action: "source-drain",
        });
        hub.message(
          parent,
          JSON.stringify({
            type: "operation-response",
            operationId: "recorded-drain",
            action: "source-drain",
          }),
        );
        await drain;
        const read = hub.request(
          "attempt",
          "source",
          new Request("http://source/"),
          "/v1/workspaces/owned/read",
        );
        const request = frames.find((frame) => frame["type"] === "http-request");
        if (!request) throw Error("Source request was not forwarded");
        hub.message(
          parent,
          JSON.stringify({ type: "http-response", streamId: request["streamId"], status: 200 }),
        );
        hub.message(parent, JSON.stringify({ type: "stream-end", streamId: request["streamId"] }));
        expect((await read).status).toBe(200);
      } else {
        await expect(
          hub.parentOperation("attempt", { operationId: "denied-drain", action: "source-drain" }),
        ).rejects.toThrow("only retained Source");
      }
      hub.message(parent, JSON.stringify({ type: "status", phase: "stopped" }));
      expect(hub.sourceConnected("attempt")).toBe(false);
      expect(
        (
          await hub.request(
            "attempt",
            "source",
            new Request("http://source/"),
            "/v1/workspaces/owned/read",
          )
        ).status,
      ).toBe(503);
      await expect(
        hub.parentOperation("attempt", { operationId: "after-stop", action: "source-drain" }),
      ).rejects.toThrow("only retained Source");
    } finally {
      hub.revoke("attempt");
    }
  },
);

test("Parent failure fences a delayed non-Source operation at its actual dispatch boundary", async () => {
  const hub = new RuntimeHub(async () => {});
  const parent = connectorSocket("parent");
  let sent = 0;
  parent.send = (() => {
    sent++;
    return 1;
  }) as typeof parent.send;
  hub.open(parent);
  const gate = Promise.withResolvers<void>();
  const operation = hub.parentOperation(
    "attempt",
    { operationId: "delayed-git", action: "workspace-git" },
    async (send) => {
      await gate.promise;
      send();
    },
  );
  hub.message(
    parent,
    JSON.stringify({ type: "status", phase: "failed", error: "original failure" }),
  );
  gate.resolve();
  try {
    await expect(operation).rejects.toThrow("only retained Source");
    expect(sent).toBe(0);
  } finally {
    hub.revoke("attempt");
  }
});

test.each(["parent", "child"] as const)(
  "%s disconnect fails its own operations and HTTP without cancelling the other Connector",
  async (closedRole) => {
    const hub = new RuntimeHub(async () => {});
    const sockets = { parent: connectorSocket("parent"), child: connectorSocket("child") };
    const frames: Record<"parent" | "child", Array<Record<string, string>>> = {
      parent: [],
      child: [],
    };
    for (const role of ["parent", "child"] as const) {
      sockets[role].send = ((text: string) => {
        frames[role].push(JSON.parse(text));
        return 1;
      }) as typeof sockets.parent.send;
      hub.open(sockets[role]);
      hub.message(
        sockets[role],
        JSON.stringify({
          type: "hello",
          role,
          channels: role === "parent" ? [{ name: "source", kind: "source" }] : [],
        }),
      );
    }
    const settled = <T>(promise: Promise<T>) =>
      promise.then(
        () => "completed",
        (error: Error) => error.message,
      );
    try {
      const operations = {
        parent: settled(
          hub.parentOperation("attempt", { operationId: "drain", action: "source-drain" }),
        ),
        child: settled(
          hub.childOperation("attempt", { operationId: "child-work", action: "process-start" }),
        ),
      };
      const requests = {
        parent: settled(
          hub.request(
            "attempt",
            "source",
            new Request("http://source/"),
            "/v1/workspaces/workspace/read",
          ),
        ),
        child: settled(hub.request("attempt", "app", new Request("http://app/"), "/")),
      };
      const liveRole = closedRole === "parent" ? "child" : "parent";
      hub.close(sockets[closedRole]);
      expect(hub.ready("attempt")).toBe(false);
      const operation = frames[liveRole].find((frame) => frame["type"] === "operation-request");
      const request = frames[liveRole].find((frame) => frame["type"] === "http-request");
      if (!operation || !request) throw new Error("Actual Connector requests were not dispatched");
      hub.message(
        sockets[liveRole],
        JSON.stringify({
          type: "operation-response",
          operationId: operation["operationId"],
          action: operation["action"],
        }),
      );
      hub.message(
        sockets[liveRole],
        JSON.stringify({ type: "http-response", streamId: request["streamId"], status: 200 }),
      );
      hub.message(
        sockets[liveRole],
        JSON.stringify({ type: "stream-end", streamId: request["streamId"] }),
      );
      expect(await operations[closedRole]).toBe("Runtime channel disconnected");
      expect(await requests[closedRole]).toBe("Runtime channel disconnected");
      expect(await operations[liveRole]).toBe("completed");
      expect(await requests[liveRole]).toBe("completed");
    } finally {
      hub.revoke("attempt");
    }
  },
);

test("canonical Source HTTP uses only the advertising Parent and strips all other credentials", async () => {
  const hub = new RuntimeHub(async () => {});
  const parent = connectorSocket("parent");
  const child = connectorSocket("child");
  const sent = Promise.withResolvers<{
    streamId: string;
    headers: Record<string, string>;
    data: string;
  }>();
  const closed: string[] = [];
  parent.send = ((text: string) => {
    const message = JSON.parse(text);
    if (message.type === "http-request") sent.resolve(message);
    if (message.type === "stream-close") closed.push(message.streamId);
    return 1;
  }) as typeof parent.send;
  hub.open(parent);
  hub.open(child);
  try {
    expect(hub.sourceConnected("attempt")).toBe(false);
    expect(
      (await hub.request("attempt", "source", new Request("http://source/"), "/")).status,
    ).toBe(503);
    hub.message(
      parent,
      JSON.stringify({
        type: "hello",
        role: "parent",
        channels: [{ name: "source", kind: "source" }],
      }),
    );
    expect(hub.sourceConnected("attempt")).toBe(true);
    const pending = hub.request(
      "attempt",
      "source",
      new Request("http://source/", {
        method: "POST",
        headers: {
          authorization: "Bearer browser-secret",
          cookie: "session=private",
          "X-Factory-Writer-Epoch": "1",
          "X-Factory-Source-Epoch": "999",
        },
        body: JSON.stringify({ path: "private.txt" }),
      }),
      "/v1/workspaces/workspace/read",
    );
    const frame = await sent.promise;
    expect(frame.headers).toEqual({ "x-factory-writer-epoch": "1" });
    expect(Buffer.from(frame.data, "base64").toString()).toBe('{"path":"private.txt"}');
    // A Child with the same Attempt/generation is still not this stream's owner.
    hub.message(
      child,
      JSON.stringify({ type: "http-response", streamId: frame.streamId, status: 201 }),
    );
    hub.message(
      parent,
      JSON.stringify({ type: "http-response", streamId: frame.streamId, status: 200 }),
    );
    const response = await pending;
    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(closed).toEqual([frame.streamId]);
    hub.message(parent, JSON.stringify({ type: "status", phase: "failed" }));
    expect(hub.sourceConnected("attempt")).toBe(true);
    expect(hub.ready("attempt")).toBe(false);
  } finally {
    hub.revoke("attempt");
  }
});

test("queued WebSocket backpressure is accepted for child and parent RPC frames", async () => {
  const hub = new RuntimeHub(async () => {});
  const parent = {
    ...connectorSocket("parent"),
    send: () => -1,
  } as ServerWebSocket<RuntimeSocketData>;
  const child = {
    ...connectorSocket("child"),
    send: () => -1,
  } as ServerWebSocket<RuntimeSocketData>;
  hub.open(parent);
  hub.open(child);
  try {
    const request = hub.childRequest("attempt", {
      operationId: "queued-chunk",
      action: "file-upload-chunk",
      data: "large chunk",
    });
    queueMicrotask(() =>
      hub.message(
        child,
        JSON.stringify({
          type: "operation-response",
          operationId: "queued-chunk",
          action: "file-upload-chunk",
          data: "accepted queued bytes",
        }),
      ),
    );
    expect(await request).toBe("accepted queued bytes");
    const operation = hub.parentOperation("attempt", {
      operationId: "queued-parent",
      action: "git-prepare-commit",
    });
    queueMicrotask(() =>
      hub.message(
        parent,
        JSON.stringify({
          type: "operation-response",
          operationId: "queued-parent",
          action: "git-prepare-commit",
          data: "accepted queued parent",
        }),
      ),
    );
    expect((await operation).data).toBe("accepted queued parent");
  } finally {
    hub.revoke("attempt");
  }
});

test("detached Commands protect compute from idle Pause until their native outcome", () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  const parent = connectorSocket("parent"),
    child = connectorSocket("child");
  hub.open(parent);
  hub.open(child);
  hub.message(
    child,
    JSON.stringify({
      type: "hello",
      role: "child",
      channels: [],
      terminalCount: 0,
      terminalBusy: 0,
      terminalRevision: 1,
      commandCount: 1,
    }),
  );
  const observed: string[] = [];
  const unsubscribe = hub.onCommandState((id, data) => observed.push(`${id}:${data}`));
  try {
    now = 10_000;
    expect(hub.attended("attempt")).toBe(false);
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    hub.message(child, JSON.stringify({ type: "command-state", commandCount: -1, data: "{}" }));
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    hub.message(
      child,
      JSON.stringify({ type: "command-state", commandCount: 0, data: '{"state":"exited"}' }),
    );
    expect(observed.at(-1)).toBe('attempt:{"state":"exited"}');
    expect(hub.claimIdle("attempt", 100)).toBe(true);
  } finally {
    unsubscribe();
    hub.revoke("attempt");
  }
});

test("Source capability is re-established after Parent reconnect; old sockets cannot answer new requests", async () => {
  const hub = new RuntimeHub(async () => {});
  const first = connectorSocket("parent");
  const second = connectorSocket("parent");
  hub.open(first);
  hub.message(
    first,
    JSON.stringify({
      type: "hello",
      role: "parent",
      channels: [{ name: "source", kind: "source" }],
    }),
  );
  hub.close(first);
  hub.open(second);
  expect(hub.sourceConnected("attempt")).toBe(false);
  hub.message(
    first,
    JSON.stringify({
      type: "hello",
      role: "parent",
      channels: [{ name: "source", kind: "source" }],
    }),
  );
  expect(hub.sourceConnected("attempt")).toBe(false);
  hub.message(
    second,
    JSON.stringify({
      type: "hello",
      role: "parent",
      channels: [{ name: "source", kind: "source" }],
    }),
  );
  expect(hub.sourceConnected("attempt")).toBe(true);
  const sent = Promise.withResolvers<{ streamId: string }>();
  second.send = ((text: string) => {
    const frame = JSON.parse(text);
    if (frame.type === "http-request") sent.resolve(frame);
    return 1;
  }) as typeof second.send;
  try {
    const pending = hub.request(
      "attempt",
      "source",
      new Request("http://source/"),
      "/v1/workspaces/workspace/events",
    );
    const frame = await sent.promise;
    hub.message(
      first,
      JSON.stringify({ type: "http-response", streamId: frame.streamId, status: 201 }),
    );
    hub.message(
      second,
      JSON.stringify({ type: "http-response", streamId: frame.streamId, status: 200 }),
    );
    expect((await pending).status).toBe(200);
    hub.revoke("attempt");
  } finally {
    hub.revoke("attempt");
  }
});

test("structured child commands return observations and recheck authority at dispatch", async () => {
  const hub = new RuntimeHub(async () => {});
  const sent: unknown[] = [];
  const child = {
    ...connectorSocket("child"),
    send(value: string) {
      sent.push(JSON.parse(value));
      return 1;
    },
  } as ServerWebSocket<RuntimeSocketData>;
  hub.open(connectorSocket("parent"));
  hub.open(child);
  try {
    const result = hub.childRequest("attempt", {
      operationId: "command-read-1",
      action: "command-read",
      data: '{"id":"command-1"}',
    });
    expect(sent.at(-1)).toMatchObject({ action: "command-read" });
    hub.message(
      child,
      JSON.stringify({
        type: "operation-response",
        operationId: "command-read-1",
        action: "command-read",
        data: '{"state":"running"}',
      }),
    );
    expect(await result).toBe('{"state":"running"}');
    const count = sent.length;
    await expect(
      hub.childRequest(
        "attempt",
        { operationId: "command-start-1", action: "command-start" },
        async () => {
          throw new Error("Workspace access removed");
        },
      ),
    ).rejects.toThrow("Workspace access removed");
    expect(sent).toHaveLength(count);
  } finally {
    hub.revoke("attempt");
  }
});

test("open Connector transports cannot announce readiness before the child's health checks", () => {
  const phases: string[] = [];
  const hub = new RuntimeHub(async (_id, phase) => {
    phases.push(phase);
  });
  const parent = connectorSocket("parent");
  const child = connectorSocket("child");
  hub.open(parent);
  hub.open(child);
  try {
    expect(hub.connected("attempt")).toBe(true);
    hub.message(parent, JSON.stringify({ type: "hello", role: "parent" }));
    hub.message(
      child,
      JSON.stringify({ type: "process-state", process: "app", processState: "running" }),
    );
    hub.message(
      child,
      JSON.stringify({
        type: "process-output",
        process: "app",
        data: Buffer.from("Waiting for HTTP readiness\n").toString("base64"),
      }),
    );
    expect(hub.processes("attempt")).toEqual([
      { name: "app", state: "running", output: "Waiting for HTTP readiness\n" },
    ]);
    expect(phases).toEqual([]);
    expect(hub.ready("attempt")).toBe(false);
    hub.message(child, JSON.stringify({ type: "hello", role: "child", channels: [] }));
    expect(phases).toEqual(["ready"]);
    expect(hub.ready("attempt")).toBe(true);
    hub.close(child);
    expect(hub.ready("attempt")).toBe(false);
    hub.open(child);
    hub.message(parent, JSON.stringify({ type: "hello", role: "parent" }));
    expect(phases.at(-1)).toBe("reconnecting");
    expect(hub.ready("attempt")).toBe(false);
    hub.message(child, JSON.stringify({ type: "hello", role: "child", channels: [] }));
    expect(phases.at(-1)).toBe("ready");
    expect(hub.ready("attempt")).toBe(true);
    hub.message(
      child,
      JSON.stringify({ type: "status", phase: "failed", error: "App startup failed" }),
    );
    expect(hub.ready("attempt")).toBe(false);
  } finally {
    hub.revoke("attempt");
  }
});

test.each(["parent", "child"] as const)(
  "both connector hellos publish readiness when %s reconnects last",
  (lastRole) => {
    const phases: string[] = [];
    const hub = new RuntimeHub(async (_id, phase) => {
      phases.push(phase);
    });
    const first = connectorSocket(lastRole === "parent" ? "child" : "parent");
    const last = connectorSocket(lastRole);
    try {
      hub.open(first);
      hub.message(
        first,
        JSON.stringify({
          type: "hello",
          role: first.data.kind === "connector" ? first.data.role : "",
        }),
      );
      expect(phases).toEqual([]);
      hub.open(last);
      hub.message(last, JSON.stringify({ type: "hello", role: lastRole }));
      expect(phases).toEqual(["ready"]);
    } finally {
      hub.revoke("attempt");
    }
  },
);

test("terminal parent status is not replaced by reconnect failure on socket close", async () => {
  const phases: string[] = [];
  const hub = new RuntimeHub(async (_id, phase) => {
    phases.push(phase);
  });
  const parent = connectorSocket("parent");
  hub.open(parent);
  hub.message(parent, JSON.stringify({ type: "status", phase: "stopped" }));
  hub.close(parent);
  expect(phases).toEqual(["stopped"]);
  hub.revoke("attempt");
});

test("idle admission retains detached PTYs and unknown observations, not unattended views", async () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  const parent = connectorSocket("parent");
  const child = connectorSocket("child");
  hub.open(parent);
  hub.open(child);
  const observe = (terminalCount: number, terminalRevision: number, terminalBusy = terminalCount) =>
    hub.message(
      child,
      JSON.stringify({
        type: "terminal-state",
        terminalCount,
        terminalBusy,
        terminalRevision,
        commandCount: 0,
      }),
    );
  try {
    now = 1000;
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(1, 1);
    now = 2000;
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(0, 0);
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(0, 2);
    now = 3000;
    observe(9, 3);
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(0, 4);
    now = 3500;
    const cancel = new AbortController();
    const view = hub.processEvents.subscribe("attempt", "viewer", cancel.signal);
    expect(hub.claimIdle("attempt", 100)).toBe(true);
    expect(hub.use("attempt")).toBe(false);
    await view.body?.cancel();
    expect((await hub.request("attempt", "app", new Request("http://app/"), "/")).status).toBe(503);
    await expect(
      hub.childOperation("attempt", { operationId: "late", action: "process-start" }),
    ).rejects.toThrow("stopping");
    hub.releaseIdle("attempt");
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    now = 4000;
    expect(hub.use("attempt")).toBe(true);
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    now = 4200;
    expect(hub.claimIdle("attempt", 100)).toBe(true);
  } finally {
    hub.revoke("attempt");
  }
});

test.each([true, false])(
  "idle admission allows only the native Work drain with a live Source owner (Source=%s)",
  async (source) => {
    let now = 0;
    const hub = new RuntimeHub(
      async () => {},
      () => now,
    );
    const parent = connectorSocket("parent");
    const child = connectorSocket("child");
    const sent: Record<string, unknown>[] = [];
    child.send = ((data: string | Buffer | Uint8Array) => {
      sent.push(JSON.parse(String(data)));
      return 1;
    }) as typeof child.send;
    hub.open(parent);
    hub.open(child);
    if (source)
      await hub.message(
        parent,
        JSON.stringify({
          type: "hello",
          role: "parent",
          channels: [{ name: "source", kind: "source" }],
        }),
      );
    await hub.message(
      child,
      JSON.stringify({
        type: "terminal-state",
        terminalCount: 0,
        terminalBusy: 0,
        terminalRevision: 1,
        commandCount: 0,
      }),
    );
    now = 1000;
    try {
      expect(hub.claimIdle("attempt", 100)).toBe(true);
      for (const action of ["source-resume", "process-start", "command-start"])
        await expect(
          hub.childOperation("attempt", { operationId: action, action }),
        ).rejects.toThrow("stopping");
      if (!source) {
        await expect(
          hub.childOperation("attempt", {
            operationId: "drain",
            action: "source-drain",
          }),
        ).rejects.toThrow("stopping");
        return;
      }
      const input = { operationId: "drain", action: "source-drain" };
      const draining = hub.childRequest("attempt", input, async (send) => {
        input.action = "process-start";
        send();
      });
      expect(sent.at(-1)).toMatchObject({
        type: "operation-request",
        operationId: "drain",
        action: "source-drain",
      });
      await hub.message(
        child,
        JSON.stringify({
          type: "operation-response",
          operationId: "drain",
          action: "source-drain",
        }),
      );
      await draining;
      await expect(
        hub.childOperation("attempt", {
          operationId: "after-drain",
          action: "process-start",
        }),
      ).rejects.toThrow("stopping");
    } finally {
      hub.revoke("attempt");
    }
  },
);

test("native Source renewal withdraws old readiness and binds its newly reported epoch", () => {
  const hub = new RuntimeHub(async () => {});
  const parent = connectorSocket("parent");
  hub.open(parent);
  const hello = (epoch?: number, source = true) =>
    hub.message(
      parent,
      JSON.stringify({
        type: "hello",
        role: "parent",
        channels: source ? [{ name: "source", kind: "source" }] : [],
        ...(epoch === undefined ? {} : { sourceEpoch: epoch }),
      }),
    );
  try {
    hello(2);
    expect(hub.sourceConnected("attempt")).toBe(true);
    expect(hub.sourceEpoch("attempt")).toBe(2);
    hello(undefined, false);
    expect(hub.sourceConnected("attempt")).toBe(false);
    expect(hub.sourceEpoch("attempt")).toBeUndefined();
    hello(5);
    expect(hub.sourceEpoch("attempt")).toBe(5);
    hello(0);
    expect(hub.sourceEpoch("attempt")).toBeUndefined();
  } finally {
    hub.revoke("attempt");
  }
});

test("an unattended Workspace pauses after the quiet grace; an open IDE keeps the full grace", () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  const parent = connectorSocket("parent");
  const child = connectorSocket("child");
  hub.open(parent);
  hub.open(child);
  hub.message(
    child,
    JSON.stringify({
      type: "terminal-state",
      commandCount: 0,
      terminalCount: 0,
      terminalBusy: 0,
      terminalRevision: 1,
    }),
  );
  const ide = {
    data: { kind: "browser", attemptID: "attempt", channel: "ide", path: "/" },
    send: () => 1,
    close() {},
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  try {
    now = 2_000;
    hub.message(
      child,
      JSON.stringify({
        type: "terminal-state",
        commandCount: 0,
        terminalCount: 0,
        terminalBusy: 0,
        terminalRevision: 1,
      }),
    );
    // 2 s of quiet is shorter than both graces.
    expect(hub.claimIdle("attempt", 10_000, 3_000)).toBe(false);
    hub.open(ide);
    expect(hub.attended("attempt")).toBe(true);
    now = 5_000;
    hub.message(
      child,
      JSON.stringify({
        type: "terminal-state",
        commandCount: 0,
        terminalCount: 0,
        terminalBusy: 0,
        terminalRevision: 1,
      }),
    );
    // Attended: the full grace applies even though the quiet grace has passed.
    expect(hub.claimIdle("attempt", 10_000, 3_000)).toBe(false);
    hub.close(ide);
    expect(hub.attended("attempt")).toBe(false);
    expect(hub.claimIdle("attempt", 10_000, 3_000)).toBe(true);
  } finally {
    hub.revoke("attempt");
  }
});

test("an App reports running once per transition for readiness timing", () => {
  const hub = new RuntimeHub(async () => {});
  const seen: string[] = [];
  hub.onAppRunning((attemptID, app) => seen.push(`${attemptID}:${app}`));
  const child = connectorSocket("child");
  hub.open(child);
  const state = (processState: string) =>
    hub.message(child, JSON.stringify({ type: "process-state", process: "app", processState }));
  try {
    state("starting");
    state("running");
    state("running");
    state("stopped");
    state("running");
    expect(seen).toEqual(["attempt:app", "attempt:app"]);
  } finally {
    hub.revoke("attempt");
  }
});

test("open terminals block automatic Pause even when the shell reports an idle prompt", () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  const parent = connectorSocket("parent");
  const child = connectorSocket("child");
  hub.open(parent);
  hub.open(child);
  const observe = (terminalBusy: number, terminalRevision: number) =>
    hub.message(
      child,
      JSON.stringify({
        type: "terminal-state",
        terminalCount: 1,
        terminalBusy,
        terminalRevision,
        commandCount: 0,
      }),
    );
  try {
    observe(0, 1);
    now = 1_000;
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(1, 2);
    now = 2_000;
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(0, 3);
    now = 20_000;
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(0, 3); // Same observation refreshes freshness, not human use.
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    now = 21_000;
    observe(1, 3); // A changed payload cannot reuse an old revision.
    expect(hub.claimIdle("attempt", 100)).toBe(false);
  } finally {
    hub.revoke("attempt");
  }
});

test("automatic Pause requires a fresh and consistent empty terminal observation", () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  hub.open(connectorSocket("parent"));
  const child = connectorSocket("child");
  hub.open(child);
  const observe = (terminalCount: number, terminalRevision: number) =>
    hub.message(
      child,
      JSON.stringify({
        type: "terminal-state",
        commandCount: 0,
        terminalCount,
        terminalBusy: 0,
        terminalRevision,
      }),
    );
  try {
    observe(0, 1);
    now = 20_000;
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    observe(0, 1);
    expect(hub.claimIdle("attempt", 100)).toBe(true);
    hub.releaseIdle("attempt");
    now = 21_000;
    observe(1, 1);
    expect(hub.claimIdle("attempt", 100)).toBe(false);
  } finally {
    hub.revoke("attempt");
  }
});

test("background HTTP reads cannot keep compute awake while a pending write remains protected", async () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  hub.open(connectorSocket("parent"));
  const child = connectorSocket("child");
  hub.open(child);
  hub.message(
    child,
    JSON.stringify({
      type: "terminal-state",
      commandCount: 0,
      terminalCount: 0,
      terminalBusy: 0,
      terminalRevision: 1,
    }),
  );
  const read = hub.request("attempt", "app", new Request("http://app/events"), "/events");
  void read.catch(() => {});
  let write: Promise<Response> | undefined;
  try {
    now = 1_000;
    expect(hub.claimIdle("attempt", 100)).toBe(true);
    hub.releaseIdle("attempt");
    write = hub.request(
      "attempt",
      "app",
      new Request("http://app/save", { method: "POST", body: "work" }),
      "/save",
    );
    void write.catch(() => {});
    await Bun.sleep(0);
    now = 2_000;
    expect(hub.claimIdle("attempt", 100)).toBe(false);
  } finally {
    hub.revoke("attempt");
    await Promise.allSettled([read, ...(write ? [write] : [])]);
  }
});

test("an idle claim admits only the native Source drain and internal checkpoint traffic needed to finish its pause", async () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  const parent = connectorSocket("parent");
  const frames: Array<Record<string, string>> = [];
  parent.send = ((raw: string) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    queueMicrotask(() => {
      if (frame.type === "operation-request")
        hub.message(
          parent,
          JSON.stringify({
            type: "operation-response",
            operationId: frame.operationId,
            action: frame.action,
          }),
        );
      if (frame.type === "http-request") {
        hub.message(
          parent,
          JSON.stringify({ type: "http-response", streamId: frame.streamId, status: 200 }),
        );
        hub.message(parent, JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
      }
    });
    return 1;
  }) as typeof parent.send;
  const child = connectorSocket("child");
  hub.open(parent);
  hub.message(
    parent,
    JSON.stringify({
      type: "hello",
      role: "parent",
      channels: [{ name: "source", kind: "source" }],
    }),
  );
  hub.open(child);
  hub.message(
    child,
    JSON.stringify({
      type: "terminal-state",
      terminalCount: 0,
      terminalBusy: 0,
      terminalRevision: 1,
    }),
  );
  hub.message(
    child,
    JSON.stringify({
      type: "hello",
      role: "child",
      commandCount: 0,
      terminalCount: 0,
      terminalBusy: 0,
      terminalRevision: 1,
    }),
  );
  now = 1000;
  try {
    expect(hub.claimIdle("attempt", 100)).toBe(true);
    await expect(
      hub.parentOperation("attempt", { operationId: "git", action: "workspace-git" }),
    ).rejects.toThrow("Runtime is stopping");
    await expect(
      hub.childOperation("attempt", { operationId: "run", action: "run" }),
    ).rejects.toThrow("Runtime is stopping");
    const prefix = "/v1/workspaces/01994a7d-0000-7000-8000-000000000001";
    for (const [channel, origin, method, path] of [
      ["app", "http://source.internal", "POST", `${prefix}/checkpoint`],
      ["source", "https://factory.test", "POST", `${prefix}/checkpoint`],
      ["source", "http://source.internal", "GET", `${prefix}/checkpoint`],
      ["source", "http://source.internal", "POST", `${prefix}/write`],
      ["source", "http://source.internal", "POST", `${prefix}/read`],
      ["source", "http://source.internal", "POST", `${prefix}/fence`],
      ["source", "http://source.internal", "POST", `${prefix}/chunk?other=1`],
    ] as const) {
      const response = await hub.request("attempt", channel, new Request(origin, { method }), path);
      expect(response.status).toBe(503);
    }
    expect(frames).toHaveLength(0);
    await hub.parentOperation("attempt", { operationId: "frozen-source", action: "source-drain" });
    for (const operation of ["checkpoint", "chunk"]) {
      const response = await hub.request(
        "attempt",
        "source",
        new Request("http://source.internal/", { method: "POST", body: "{}" }),
        `${prefix}/${operation}`,
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(frames.map((frame) => frame["action"] ?? frame["path"])).toEqual([
      "source-drain",
      `${prefix}/checkpoint`,
      `${prefix}/chunk`,
    ]);
    expect(hub.use("attempt")).toBe(false);
  } finally {
    hub.revoke("attempt");
  }
});

describe("Runtime membership revocation", () => {
  test("a revoked viewer cannot dispatch a request whose body was still arriving", async () => {
    const hub = new RuntimeHub(async () => {});
    const child = connectorSocket("child");
    const frames: string[] = [];
    child.send = (raw) => {
      frames.push(String(raw));
      return 1;
    };
    hub.open(child);
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    let permitted = true;
    try {
      const response = hub.request(
        "attempt",
        "app",
        new Request("http://factory/action", { method: "POST", body }),
        "/action",
        async (send) => {
          if (!permitted) throw new Error("Runtime access revoked");
          send();
        },
        "revoked",
      );
      permitted = false;
      hub.revokeAccess("revoked");
      if (!bodyController) throw new Error("Request body did not initialize");
      bodyController.close();
      await expect(response).rejects.toThrow("Runtime access revoked");
      expect(frames.map((frame) => JSON.parse(frame).type)).toEqual(["stream-close"]);
    } finally {
      hub.revoke("attempt");
    }
  });
  test("closes only the revoked viewer's IDE, terminal and Preview without stopping shared compute", () => {
    const hub = new RuntimeHub(async () => {});
    const parent = connectorSocket("parent");
    const child = connectorSocket("child");
    const frames: Array<Record<string, unknown>> = [];
    child.send = (raw) => {
      frames.push(JSON.parse(String(raw)));
      return 1;
    };
    hub.open(parent);
    hub.open(child);
    const closed: string[] = [];
    function viewer(accessToken: string, channel: string) {
      return {
        data: { kind: "browser", attemptID: "attempt", channel, path: "/", accessToken },
        send: () => 1,
        close: () => {
          closed.push(`${accessToken}:${channel}`);
        },
      } as unknown as ServerWebSocket<RuntimeSocketData>;
    }
    try {
      for (const channel of ["ide", "terminal", "app"]) {
        hub.open(viewer("revoked", channel));
        hub.open(viewer("retained", channel));
      }
      hub.revokeAccess("revoked");
      expect(closed.sort()).toEqual(["revoked:app", "revoked:ide", "revoked:terminal"]);
      expect(frames.filter((frame) => frame["type"] === "stream-close")).toHaveLength(3);
      expect(hub.connected("attempt")).toBe(true);
      expect(frames.some((frame) => frame["type"] === "stop")).toBe(false);
    } finally {
      hub.revoke("attempt");
    }
  });

  test("revokes a live HTTP response without interrupting another viewer's response", async () => {
    const hub = new RuntimeHub(async () => {});
    const parent = connectorSocket("parent");
    const child = connectorSocket("child");
    const frames: Array<Record<string, unknown>> = [];
    child.send = (raw) => {
      frames.push(JSON.parse(String(raw)));
      return 1;
    };
    hub.open(parent);
    hub.open(child);
    try {
      const revoked = hub.request(
        "attempt",
        "app",
        new Request("http://factory/events"),
        "/events",
        undefined,
        "revoked",
      );
      const retained = hub.request(
        "attempt",
        "app",
        new Request("http://factory/events"),
        "/events",
        undefined,
        "retained",
      );
      const [revokedID, retainedID] = frames
        .filter((frame) => frame["type"] === "http-request")
        .map((frame) => frame["streamId"]);
      for (const streamId of [revokedID, retainedID]) {
        hub.message(child, JSON.stringify({ type: "http-response", streamId, status: 200 }));
      }
      const revokedRead = (await revoked).text().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      const retainedRead = (await retained).text();
      hub.revokeAccess("revoked");
      expect(await revokedRead).toMatchObject({ message: "Runtime access revoked" });
      hub.message(
        child,
        JSON.stringify({
          type: "stream-data",
          streamId: retainedID,
          data: Buffer.from("still connected").toString("base64"),
        }),
      );
      hub.message(child, JSON.stringify({ type: "stream-end", streamId: retainedID }));
      expect(await retainedRead).toBe("still connected");
      expect(hub.connected("attempt")).toBe(true);
    } finally {
      hub.revoke("attempt");
    }
  });
});

describe("Runtime connection recovery", () => {
  test.each(["parent", "child", "both"] as const)(
    "%s connection loss permits the same runtime to reconnect without destruction",
    (lost) => {
      const phases: string[] = [];
      const hub = new RuntimeHub(async (_attempt, phase) => {
        phases.push(phase);
      });
      const parent = connectorSocket("parent");
      const child = connectorSocket("child");
      hub.open(parent);
      hub.open(child);
      hub.message(parent, JSON.stringify({ type: "hello", role: "parent" }));
      hub.message(child, JSON.stringify({ type: "hello", role: "child", channels: [] }));
      try {
        if (lost === "parent" || lost === "both") hub.close(parent);
        if (lost === "child" || lost === "both") hub.close(child);
        expect(phases).not.toContain("disconnected");
        expect(phases).toContain("reconnecting");
        if (lost === "parent" || lost === "both") {
          hub.open(parent);
          hub.message(parent, JSON.stringify({ type: "hello", role: "parent" }));
        }
        if (lost === "child" || lost === "both") {
          hub.open(child);
          hub.message(child, JSON.stringify({ type: "hello", role: "child", channels: [] }));
        }
        expect(hub.connected("attempt")).toBe(true);
        expect(phases.at(-1)).toBe("ready");
      } finally {
        hub.revoke("attempt");
      }
    },
  );

  test("a replaced Connector cannot publish late readiness or failure", () => {
    const phases: string[] = [];
    const hub = new RuntimeHub(async (_attempt, phase) => {
      phases.push(phase);
    });
    const parent = connectorSocket("parent");
    const old = connectorSocket("child");
    hub.open(parent);
    hub.open(old);
    try {
      hub.close(old);
      hub.open(connectorSocket("child"));
      const before = [...phases];
      hub.message(old, JSON.stringify({ type: "hello", role: "child", channels: [] }));
      hub.message(old, JSON.stringify({ type: "status", phase: "failed", error: "old socket" }));
      expect(phases).toEqual(before);
    } finally {
      hub.revoke("attempt");
    }
  });
});

describe("Runtime parent operation dispatch", () => {
  function fixture() {
    const hub = new RuntimeHub(async () => {});
    const frames: Record<string, string>[] = [];
    const parent = connectorSocket("parent");
    parent.send = (raw) => {
      frames.push(JSON.parse(String(raw)) as Record<string, string>);
      return 1;
    };
    hub.open(parent);
    const operation = {
      operationId: "owned-commit",
      action: "git-prepare-commit",
      expectedSha: "a".repeat(40),
    };
    function respond(action = operation.action, socket = parent) {
      hub.message(
        socket,
        JSON.stringify({
          type: "operation-response",
          operationId: operation.operationId,
          action,
          commitSha: "b".repeat(40),
        }),
      );
    }
    return { hub, parent, frames, operation, respond };
  }

  test("identical pending input with reordered fields coalesces without another frame or guard", async () => {
    const { hub, frames, operation, respond } = fixture();
    let guards = 0;
    try {
      const first = hub.parentOperation("attempt", operation);
      const second = hub.parentOperation(
        "attempt",
        {
          expectedSha: operation.expectedSha,
          action: operation.action,
          operationId: operation.operationId,
        },
        async (send) => {
          guards += 1;
          send();
        },
      );
      expect(frames).toHaveLength(1);
      respond();
      expect(await first).toEqual({ commitSHA: "b".repeat(40) });
      expect(await second).toEqual(await first);
      expect(guards).toBe(0);
    } finally {
      hub.revoke("attempt");
    }
  });

  test.each(["action", "payload", "attempt"] as const)(
    "conflicting %s reuse preserves the original waiter",
    async (conflict) => {
      const { hub, frames, operation, respond } = fixture();
      try {
        const first = hub.parentOperation("attempt", operation);
        if (conflict === "attempt") {
          const other = connectorSocket("parent");
          other.data = { kind: "connector", role: "parent", attemptID: "other", generation: 1 };
          hub.open(other);
        }
        const changed = {
          ...operation,
          ...(conflict === "action"
            ? { action: "git-push" }
            : conflict === "payload"
              ? { expectedSha: "c".repeat(40) }
              : {}),
        };
        await expect(
          hub.parentOperation(conflict === "attempt" ? "other" : "attempt", changed),
        ).rejects.toThrow("conflicting input");
        expect(frames).toHaveLength(1);
        respond();
        expect(await first).toEqual({ commitSHA: "b".repeat(40) });
      } finally {
        hub.revoke("attempt");
        hub.revoke("other");
      }
    },
  );

  test("another phase or an old parent cannot settle the pending operation", async () => {
    const { hub, parent, operation, respond } = fixture();
    let settled = false;
    const first = hub.parentOperation("attempt", operation).then((result) => {
      settled = true;
      return result;
    });
    try {
      respond("git-push");
      respond(operation.action, connectorSocket("parent"));
      await Bun.sleep(0);
      expect(settled).toBe(false);
      respond(operation.action, parent);
      expect(await first).toEqual({ commitSHA: "b".repeat(40) });
    } finally {
      hub.revoke("attempt");
      await first.catch(() => undefined);
    }
  });

  test.each(["suspend", "revoke", "parent replacement"] as const)(
    "a held guard cannot send after %s",
    async (boundary) => {
      const { hub, parent, frames, operation } = fixture();
      const release = Promise.withResolvers<void>();
      const joined = Promise.withResolvers<void>();
      const result = hub
        .parentOperation("attempt", operation, async (send) => {
          await release.promise;
          try {
            send();
          } finally {
            joined.resolve();
          }
        })
        .then(
          () => "sent",
          () => "rejected",
        );
      try {
        if (boundary === "suspend") hub.suspend("attempt");
        if (boundary === "revoke") hub.revoke("attempt");
        if (boundary === "parent replacement") {
          hub.close(parent);
          hub.open(connectorSocket("parent"));
        }
        release.resolve();
        expect(await result).toBe("rejected");
        await joined.promise;
        expect(frames).toHaveLength(0);
      } finally {
        release.resolve();
        hub.revoke("attempt");
        await joined.promise;
        await result;
      }
    },
  );

  test("a held renewal guard cannot dispatch after its acknowledgement deadline", async () => {
    const { hub, frames, operation } = fixture();
    const release = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const result = hub
      .parentOperation("attempt", { ...operation, action: "browser-renew" }, async (send) => {
        await release.promise;
        try {
          send();
        } finally {
          joined.resolve();
        }
      })
      .then(
        () => "sent",
        (cause: Error) => cause.message,
      );
    try {
      expect(await result).toBe("Runtime parent operation timed out");
      release.resolve();
      await joined.promise;
      expect(frames).toHaveLength(0);
    } finally {
      release.resolve();
      hub.revoke("attempt");
      await joined.promise;
      await result;
    }
  }, 15_000);
});

describe("Runtime edge headers", () => {
  test("App responses cannot plant Factory cookies or escape their own runtime path", () => {
    const path = `/runtime/${"a".repeat(8)}-0000-4000-8000-${"a".repeat(12)}/preview/app`;
    const headers = new Headers();
    for (const value of [
      "factory.session_token=spoof; Domain=localhost; Path=/",
      "__Secure-better-auth.session_token=spoof; Secure; Path=/",
      "theia-connection-token=spoof; Path=/",
      "starter.session_token=app; Domain=localhost; Path=/; HttpOnly; SameSite=Lax",
      "theme=light; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
    ])
      headers.append("set-cookie", value);
    const scoped = scopeAppCookies(new Response("App", { headers }), path);
    expect(scoped.headers.getSetCookie()).toEqual([
      `starter.session_token=app; HttpOnly; Path=${path}; SameSite=None; Secure; Partitioned`,
      `theme=light; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=${path}; SameSite=None; Secure; Partitioned`,
    ]);
    expect(() => scopeAppCookies(new Response(), "/")).toThrow("scoped");
  });
  test("App logout preserves expiry while replacing contradictory cookie isolation attributes", () => {
    const path = `/runtime/${crypto.randomUUID()}/app`;
    const response = scopeAppCookies(
      new Response(null, {
        headers: {
          "set-cookie":
            "starter.session_token=; Max-Age=0; HttpOnly; Domain=other.test; Path=/; SameSite=Strict; samesite=Lax; SECURE; partitioned",
        },
      }),
      path,
    );
    expect(response.headers.getSetCookie()).toEqual([
      `starter.session_token=; Max-Age=0; HttpOnly; Path=${path}; SameSite=None; Secure; Partitioned`,
    ]);
  });
  test("App requests retain their cookies and exact proxy path without Factory credentials or spoofed proxy headers", () => {
    const id = crypto.randomUUID();
    const host = `${id.replaceAll("-", "")}-app.runtime.localhost:3000`;
    const prefix = `/runtime/${id}/preview/app`;
    const request = new Request(`http://${host}${prefix}/api/auth/sign-in/email`, {
      headers: {
        origin: `http://${host}`,
        authorization: "Bearer infrastructure",
        cookie:
          "factory_runtime_access=secret; factory.session_token=secret; __Secure-better-auth.session_token=secret; starter.session_token=app-session; theme=light",
        "x-forwarded-host": "evil.test",
        "x-forwarded-prefix": "/bad",
        "x-forwarded-proto": "https",
      },
    });
    expect(appRuntimeHeaders(request, "/api/auth/sign-in/email")).toEqual({
      "x-forwarded-host": host,
      "x-forwarded-prefix": prefix,
      "x-forwarded-proto": "http",
      origin: `http://${host}`,
      cookie: "starter.session_token=app-session; theme=light",
    });
    expect(
      appRuntimeHeaders(
        new Request("http://factory.test/api/secret", {
          headers: { cookie: "secret=value", "x-forwarded-host": "evil.test" },
        }),
        "/secret",
      ),
    ).toEqual({});
    expect(() =>
      appRuntimeHeaders(new Request(`http://${host}/runtime/${id}/wrong/api`), "/api"),
    ).toThrow("scoped");
  });
  test("public HTTPS App context survives the Ingress HTTP hop without trusting forwarding headers", () => {
    const previous = process.env["FACTORY_BASE_URL"];
    process.env["FACTORY_BASE_URL"] = "https://factory.example.com";
    try {
      const id = "01994a7d-0000-7000-8000-000000000001";
      const host = `${id.replaceAll("-", "")}-app.runtime.factory.example.com`;
      const prefix = `/runtime/${id}/preview/app`;
      const headers = appRuntimeHeaders(
        new Request(`http://${host}${prefix}/api/auth/sign-in/email`, {
          headers: {
            origin: `https://${host}`,
            "x-forwarded-host": "untrusted.example",
            "x-forwarded-proto": "http",
            cookie: "starter.session_token=owned-app-session; factory_runtime_access=private",
          },
        }),
        "/api/auth/sign-in/email",
      );
      expect(headers).toEqual({
        "x-forwarded-host": host,
        "x-forwarded-prefix": prefix,
        "x-forwarded-proto": "https",
        origin: `https://${host}`,
        cookie: "starter.session_token=owned-app-session",
      });
    } finally {
      if (previous === undefined) delete process.env["FACTORY_BASE_URL"];
      else process.env["FACTORY_BASE_URL"] = previous;
    }
  });
  test("strips Factory and upgrade credentials before Connector serialization", () => {
    const headers = safeRuntimeHeaders(
      new Headers({
        authorization: "Bearer factory-secret",
        cookie: "factory.session_token=secret",
        origin: "http://127.0.0.1:3000",
        host: "runtime.localhost:3000",
        connection: "upgrade",
        "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
        upgrade: "websocket",
        "sec-websocket-key": "secret-key",
        accept: "text/html",
        "user-agent": "browser",
      }),
    );
    expect(headers).toEqual({ accept: "text/html", "user-agent": "browser" });
  });

  test("extracts only Theia's scoped connection token", () => {
    const headers = new Headers({
      cookie:
        "factory_runtime_access=runtime-secret; theia-connection-token=theia-token_123; factory.session_token=session-secret",
    });
    expect(theiaConnectionToken(headers)).toBe("theia-token_123");
    expect(safeRuntimeHeaders(headers)).toEqual({});
    expect(
      theiaConnectionToken(
        new Headers({ cookie: "theia-connection-token=bad%0d%0aX-Factory-Secret" }),
      ),
    ).toBeUndefined();
  });

  test("scopes Theia's iframe cookie without exposing Factory cookies", async () => {
    const response = scopeTheiaConnectionCookie(
      new Response("IDE", {
        headers: {
          "set-cookie": "theia-connection-token=theia-token_123; Path=/; HttpOnly; SameSite=Strict",
        },
      }),
      "/runtime/attempt/ide/",
    );
    expect(response.headers.get("set-cookie")).toBe(
      "theia-connection-token=theia-token_123; Path=/runtime/attempt/ide/; HttpOnly; SameSite=None; Secure; Partitioned",
    );
    expect(await response.text()).toBe("IDE");
  });
});

describe("Runtime Connector recovery", () => {
  test("publishes ready only after both Connector roles return", async () => {
    const phases: string[] = [];
    const hub = new RuntimeHub(async (_attemptID, phase) => {
      phases.push(phase);
    });
    const child = connectorSocket("child");
    hub.open(child);
    hub.message(child, JSON.stringify({ type: "hello", role: "child" }));
    await Bun.sleep(0);
    expect(phases).toEqual([]);

    const parent = connectorSocket("parent");
    hub.open(parent);
    hub.message(parent, JSON.stringify({ type: "hello", role: "parent" }));
    await Bun.sleep(0);
    expect(phases).toEqual(["ready"]);
  });

  test("revokes Connector authorization when Stop has no parent connection", () => {
    const hub = new RuntimeHub(async () => {});
    const token = "parent-token";
    const hashToken = (value: string) => `hash:${value}`;
    hub.allow("attempt", 1, hashToken(token), hashToken("child-token"));
    expect(
      hub.authorize(
        new Request("http://factory/internal/runtime-connect", {
          headers: {
            authorization: `Bearer ${token}`,
            "x-factory-connector-role": "parent",
            "x-factory-runtime-attempt": "attempt",
            "x-factory-runtime-generation": "1",
          },
        }),
        hashToken,
      ),
    ).not.toBeNull();

    expect(hub.stop("attempt")).toBe(false);
    expect(
      hub.authorize(
        new Request("http://factory/internal/runtime-connect", {
          headers: {
            authorization: `Bearer ${token}`,
            "x-factory-connector-role": "parent",
            "x-factory-runtime-attempt": "attempt",
            "x-factory-runtime-generation": "1",
          },
        }),
        hashToken,
      ),
    ).toBeNull();
  });

  test("keeps bounded process state and output in runtime memory", () => {
    const hub = new RuntimeHub(async () => {});
    const child = connectorSocket("child");
    hub.open(child);
    hub.message(
      child,
      JSON.stringify({
        type: "process-state",
        process: "app-worker",
        processState: "running",
      }),
    );
    hub.message(
      child,
      JSON.stringify({
        type: "process-output",
        process: "app-worker",
        data: Buffer.from("Worker monitor ready on 4310\n").toString("base64"),
      }),
    );

    expect(hub.processes("attempt")).toEqual([
      {
        name: "app-worker",
        state: "running",
        output: "Worker monitor ready on 4310\n",
      },
    ]);
    hub.revoke("attempt");
    expect(hub.processes("attempt")).toEqual([]);
  });

  test.each(["running", "stopped", "failed"] as const)(
    "Parent setup %s remains separate from Child readiness and App health",
    (state) => {
      const phases: string[] = [];
      const apps: string[] = [];
      const hub = new RuntimeHub(async (_attempt, phase) => {
        phases.push(phase);
      });
      hub.onAppRunning((_attempt, app) => apps.push(app));
      const parent = connectorSocket("parent");
      const child = connectorSocket("child");
      hub.open(parent);
      hub.open(child);
      const setup = {
        type: "process-state",
        process: "setup",
        processLabel: "Project setup",
        processState: state,
        startedAt: "2026-11-23T12:00:00Z",
        ...(state === "running" ? {} : { exitCode: state === "failed" ? 7 : 0 }),
      };
      try {
        hub.message(parent, JSON.stringify(setup));
        hub.message(
          parent,
          JSON.stringify({
            type: "process-output",
            process: "setup",
            data: Buffer.from("Optional setup output [REDACTED]\n").toString("base64"),
          }),
        );
        const expected = {
          name: "setup",
          label: "Project setup",
          state,
          startedAt: setup.startedAt,
          ...(setup.exitCode === undefined ? {} : { exitCode: setup.exitCode }),
          output: "Optional setup output [REDACTED]\n",
        };
        expect(hub.processes("attempt")).toEqual([expected]);
        expect(hub.ready("attempt")).toBe(false);
        hub.message(parent, JSON.stringify({ type: "hello", role: "parent" }));
        hub.message(
          child,
          JSON.stringify({
            type: "hello",
            role: "child",
            channels: [{ name: "app", kind: "app" }],
          }),
        );
        expect(hub.processes("attempt")).toEqual([expected]);
        expect(hub.ready("attempt")).toBe(true);
        expect(phases).toEqual(["ready"]);
        expect(apps).toEqual([]);
        expect(hub.hasAppChannel("attempt", "setup")).toBe(false);
        hub.message(
          child,
          JSON.stringify({ type: "process-state", process: "app", processState: "running" }),
        );
        expect(apps).toEqual(["app"]);
      } finally {
        hub.revoke("attempt");
      }
    },
  );

  test("only the current Parent owns setup; Child hello preserves it, Parent loss invalidates it", () => {
    const hub = new RuntimeHub(async () => {});
    const parent = connectorSocket("parent");
    const child = connectorSocket("child");
    const state = { type: "process-state", process: "setup", processState: "running" };
    const output = {
      type: "process-output",
      process: "setup",
      data: Buffer.from("owned setup\n").toString("base64"),
    };
    hub.open(parent);
    hub.open(child);
    try {
      hub.message(parent, JSON.stringify(state));
      hub.message(parent, JSON.stringify(output));
      expect(hub.processes("attempt")).toHaveLength(1);
      for (const [producer, process] of [
        [child, "setup"],
        [parent, "app"],
        [parent, "setup-extra"],
      ] as const) {
        hub.message(producer, JSON.stringify({ ...state, process, processState: "failed" }));
        hub.message(producer, JSON.stringify({ ...output, process }));
      }
      expect(hub.processes("attempt")).toMatchObject([
        { name: "setup", state: "running", output: "owned setup\n" },
      ]);
      hub.close(child);
      const replacementChild = connectorSocket("child");
      hub.open(replacementChild);
      hub.message(replacementChild, JSON.stringify({ type: "hello", role: "child" }));
      expect(hub.processes("attempt")).toHaveLength(1);
      hub.close(parent);
      expect(hub.processes("attempt")).toEqual([]);
      const replacementParent = connectorSocket("parent");
      hub.open(replacementParent);
      hub.message(parent, JSON.stringify(state));
      hub.message(parent, JSON.stringify(output));
      expect(hub.processes("attempt")).toEqual([]);
      hub.message(replacementParent, JSON.stringify(state));
      expect(hub.processes("attempt")).toHaveLength(1);
      hub.revoke("attempt");
      hub.message(replacementParent, JSON.stringify(output));
      expect(hub.processes("attempt")).toEqual([]);
    } finally {
      hub.revoke("attempt");
    }
  });

  test("setup keeps a reserved bounded process entry and complete-line output tail", () => {
    const hub = new RuntimeHub(async () => {});
    const parent = connectorSocket("parent");
    const child = connectorSocket("child");
    hub.open(parent);
    hub.open(child);
    try {
      for (let index = 0; index < 64; index++)
        hub.message(
          child,
          JSON.stringify({
            type: "process-state",
            process: `app-worker-${index}`,
            processState: "running",
          }),
        );
      hub.message(
        parent,
        JSON.stringify({ type: "process-state", process: "setup", processState: "running" }),
      );
      const line = "setup output [REDACTED]\n";
      for (let index = 0; index < 3; index++)
        hub.message(
          parent,
          JSON.stringify({
            type: "process-output",
            process: "setup",
            data: Buffer.from(line.repeat(1_500)).toString("base64"),
          }),
        );
      const processes = hub.processes("attempt");
      expect(processes.length).toBeLessThanOrEqual(16);
      const setup = processes.find((process) => process.name === "setup");
      expect(setup?.output.length).toBeGreaterThan(0);
      expect(setup?.output.length).toBeLessThanOrEqual(32 << 10);
      expect(setup?.output).toMatch(/^(setup output \[REDACTED\]\n)+$/);
    } finally {
      hub.revoke("attempt");
    }
  });

  test("acknowledges scoped child operations and declared App channels", async () => {
    const sent: Array<Record<string, string>> = [];
    const child = {
      data: { kind: "connector", role: "child", attemptID: "attempt", generation: 1 },
      close() {},
      send(raw: string) {
        sent.push(JSON.parse(raw) as Record<string, string>);
        return 1;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    const hub = new RuntimeHub(async () => {});
    hub.open(child);
    hub.message(
      child,
      JSON.stringify({
        type: "hello",
        role: "child",
        channels: [
          { name: "app", kind: "app" },
          { name: "app-worker", kind: "app" },
          { name: "ide", kind: "ide" },
        ],
      }),
    );
    expect(hub.hasAppChannel("attempt", "app-worker")).toBe(true);
    expect(hub.hasAppChannel("attempt", "ide")).toBe(false);

    const operation = hub.childOperation("attempt", {
      operationId: "operation-1",
      action: "process-restart",
      process: "app-worker",
    });
    expect(sent.at(-1)).toMatchObject({
      type: "operation-request",
      operationId: "operation-1",
      action: "process-restart",
      process: "app-worker",
    });
    hub.message(child, JSON.stringify({ type: "operation-response", operationId: "operation-1" }));
    await expect(operation).resolves.toBeUndefined();
  });

  test("a failed child send settles its owned operation before revocation", async () => {
    for (const failure of ["throw", "refuse"] as const) {
      const child = {
        data: { kind: "connector", role: "child", attemptID: "attempt", generation: 1 },
        close() {},
        send() {
          if (failure === "throw") throw new Error("socket closed during send");
          return 0;
        },
      } as unknown as ServerWebSocket<RuntimeSocketData>;
      const hub = new RuntimeHub(async () => {});
      hub.open(child);
      await expect(
        hub.childOperation("attempt", { operationId: failure, action: "process-start" }),
      ).rejects.toThrow(
        failure === "throw"
          ? "socket closed during send"
          : "Runtime child operation could not be sent",
      );
      // Revocation must not reject a forgotten promise left behind by send.
      hub.revoke("attempt");
      await Promise.resolve();
    }
  });

  test("a pending child operation cannot be replaced by the same identity", async () => {
    let sends = 0;
    const child = {
      data: { kind: "connector", role: "child", attemptID: "attempt", generation: 1 },
      close() {},
      send() {
        sends++;
        return 1;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    const hub = new RuntimeHub(async () => {});
    hub.open(child);
    const input = { operationId: "owned-operation", action: "process-start" };
    const first = hub.childOperation("attempt", input);
    await expect(hub.childOperation("attempt", input)).rejects.toThrow(
      "Runtime child operation is already pending",
    );
    expect(sends).toBe(1);
    hub.message(
      child,
      JSON.stringify({
        type: "operation-response",
        operationId: input.operationId,
        action: input.action,
      }),
    );
    await expect(first).resolves.toBeUndefined();
  });
});

describe("Runtime terminal attachment readiness", () => {
  test.each([
    "/?token=hmr",
    "/@vite/client?token=hmr&route=%2Fforms%2F",
    "https://app.internal/@vite/client?token=hmr&route=%2Fforms%2F",
  ])("origin-scoped App sockets have no public mount for %s", (path) => {
    const id = "01994a7d-0000-7000-8000-000000000001";
    const host = `${id.replaceAll("-", "")}app-forms.runtime.factory.example`;
    const target = new URL(path, "https://app.internal");
    const request = new Request(
      `https://${host}/runtime/${id}/preview/app-forms${target.pathname}${target.search}`,
      {
        headers: {
          host: "spoofed.test",
          origin: `https://${host}`,
          cookie: "factory_runtime_access=secret; starter.session_token=app",
          authorization: "Bearer factory-secret",
          forwarded: "host=spoofed.test;proto=http",
          "x-forwarded-host": "spoofed.test",
          "x-forwarded-proto": "http",
          "x-forwarded-prefix": "/spoofed",
          "sec-websocket-protocol": "vite-hmr",
          "sec-websocket-key": "private-key",
        },
      },
    );
    expect(appRuntimeSocketContext(request, path, true)).toEqual({
      protocol: "vite-hmr",
      headers: {
        "x-forwarded-host": host,
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "",
        origin: `https://${host}`,
        cookie: "starter.session_token=app",
      },
    });
  });

  test("App sockets keep scoped cookies and the requested native protocol without upgrade credentials", () => {
    const id = crypto.randomUUID();
    const prefix = `/runtime/${id}/app`;
    const request = new Request(
      `http://${id.replaceAll("-", "")}-app.runtime.localhost:3000${prefix}/?token=hmr`,
      {
        headers: {
          cookie: "factory_runtime_access=secret; starter.session_token=app",
          "sec-websocket-protocol": "vite-hmr",
          authorization: "Bearer secret",
        },
      },
    );
    const context = appRuntimeSocketContext(request, "/?token=hmr");
    expect(context.protocol).toBe("vite-hmr");
    expect(context.headers["cookie"]).toBe("starter.session_token=app");
    expect(context.headers["x-forwarded-prefix"]).toBe(prefix);
    expect(context.headers["sec-websocket-protocol"]).toBeUndefined();
    expect(context.headers["authorization"]).toBeUndefined();
  });
  function fixture(channel = "terminal") {
    const outgoing: Array<Record<string, unknown>> = [];
    const received: string[] = [];
    const closed: number[] = [];
    const child = connectorSocket("child");
    child.send = (raw) => {
      outgoing.push(JSON.parse(String(raw)));
      return 1;
    };
    const browser = {
      data: { kind: "browser", attemptID: "attempt", channel, path: "/terminal-one" },
      send(raw: string) {
        received.push(String(raw));
        return 1;
      },
      close(code: number) {
        closed.push(code);
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    const hub = new RuntimeHub(async () => {});
    hub.open(child);
    hub.open(browser);
    const streamId = outgoing[0]?.["streamId"];
    return { hub, child, browser, outgoing, received, closed, streamId };
  }

  test("announces terminal readiness only after Connector attachment, once", () => {
    const { hub, child, browser, received, outgoing, streamId } = fixture();
    expect(received).toEqual([]);
    hub.message(browser, JSON.stringify({ type: "resize", columns: 100, rows: 30 }));
    expect(outgoing).toHaveLength(1);
    const ready = JSON.stringify({ type: "websocket-ready", streamId });
    hub.message(child, ready);
    expect(received).toEqual(['{"type":"terminal-ready"}']);
    expect(outgoing.at(-1)).toMatchObject({ type: "websocket-message", streamId });
    hub.message(child, ready);
    expect(received).toHaveLength(1);
  });

  test.each(["ide", "app"])("does not inject terminal control into %s", (channel) => {
    const { hub, child, received, streamId } = fixture(channel);
    hub.message(child, JSON.stringify({ type: "websocket-ready", streamId }));
    expect(received).toEqual([]);
  });

  test("ignores a different Connector attempting to publish terminal output", () => {
    const { hub, received, streamId } = fixture();
    hub.message(
      connectorSocket("parent"),
      JSON.stringify({
        type: "websocket-message",
        streamId,
        messageType: 1,
        data: Buffer.from("wrong connector output").toString("base64"),
      }),
    );
    expect(received).toEqual([]);
  });

  test.each(["websocket-ready", "websocket-message", "stream-close", "stream-error"])(
    "ignores %s from the wrong attempt or a replaced child",
    (type) => {
      const { hub, child, received, closed, streamId } = fixture();
      const other = connectorSocket("child");
      other.data = { kind: "connector", role: "child", attemptID: "other", generation: 1 };
      hub.open(other);
      const raw = JSON.stringify({
        type,
        streamId,
        messageType: 1,
        data: Buffer.from("wrong attempt output").toString("base64"),
      });
      hub.message(other, raw);
      expect(received).toEqual([]);
      expect(closed).toEqual([]);
      hub.message(child, JSON.stringify({ type: "websocket-ready", streamId }));
      expect(received).toEqual(['{"type":"terminal-ready"}']);
      received.length = 0;
      hub.close(child);
      const replacement = connectorSocket("child");
      hub.open(replacement);
      hub.message(child, raw);
      expect(received).toEqual([]);
      expect(closed).toEqual([1012]);
      hub.revoke("attempt");
      hub.revoke("other");
    },
  );

  test("keeps early input bounded while waiting for attachment", () => {
    const { hub, browser, outgoing, closed } = fixture();
    for (let frame = 0; frame < 17; frame++) hub.message(browser, Buffer.from("input"));
    expect(outgoing).toHaveLength(1);
    expect(closed).toEqual([1009]);
  });
});

describe("Runtime HTTP streaming", () => {
  function fixture(hub = new RuntimeHub(async () => {})) {
    const sent: Array<{
      type: string;
      streamId?: string;
      headers?: Record<string, string>;
      appAuthorization?: string;
    }> = [];
    const child = connectorSocket("child");
    child.send = (raw) => {
      sent.push(JSON.parse(String(raw)));
      return 1;
    };
    hub.open(child);
    return { hub, child, sent };
  }

  function browserAppFixture(hub?: RuntimeHub) {
    const value = fixture(hub);
    const { child } = value;
    value.hub.message(
      child,
      JSON.stringify({
        type: "hello",
        role: "child",
        channels: [
          { name: "app", kind: "app" },
          { name: "agent", kind: "agent" },
        ],
        terminalCount: 0,
        terminalBusy: 0,
        terminalRevision: 1,
        commandCount: 0,
      }),
    );
    return { ...value, admit: async (send: () => void) => send() };
  }

  test.each([false, true])(
    "App HTTP forwards the public base rather than the internal mount (origin scoped=%s)",
    async (originScoped) => {
      const { hub, child, sent } = fixture();
      const id = "01994a7d-0000-7000-8000-000000000001";
      const host = `${id.replaceAll("-", "")}app-forms.runtime.factory.example`;
      const prefix = `/runtime/${id}/preview/app-forms`;
      const path = "/?route=%2Fforms%2F&revision=1";
      hub.message(
        child,
        JSON.stringify({
          type: "hello",
          role: "child",
          channels: [{ name: "app-forms", kind: "app" }],
        }),
      );
      try {
        const request = hub.request(
          "attempt",
          "app-forms",
          new Request(`https://${host}${prefix}${path}`, {
            headers: {
              host: "spoofed.test",
              origin: `https://${host}`,
              authorization: "Bearer factory-secret",
              cookie: "factory_runtime_access=secret; starter.session_token=app",
              forwarded: "host=spoofed.test;proto=http",
              "x-forwarded-host": "spoofed.test",
              "x-forwarded-proto": "http",
              "x-forwarded-prefix": "/spoofed",
            },
          }),
          path,
          undefined,
          undefined,
          originScoped,
        );
        const streamId = sent[0]?.["streamId"];
        hub.message(child, JSON.stringify({ type: "http-response", streamId, status: 204 }));
        hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
        const response = await request;
        expect(sent[0]).toMatchObject({
          type: "http-request",
          channel: "app-forms",
          path,
          headers: {
            "x-forwarded-host": host,
            "x-forwarded-proto": "https",
            "x-forwarded-prefix": originScoped ? "" : prefix,
            origin: `https://${host}`,
            cookie: "starter.session_token=app",
          },
        });
        expect(Object.keys(sent[0]?.headers ?? {}).sort()).toEqual([
          "cookie",
          "origin",
          "x-forwarded-host",
          "x-forwarded-prefix",
          "x-forwarded-proto",
        ]);
        expect(response.status).toBe(204);
      } finally {
        hub.revoke("attempt");
      }
    },
  );

  test("isolated Browser App HTTP preserves only its App credentials and ordinary headers", async () => {
    const { hub, child, sent } = browserAppFixture();
    try {
      let guarded = false;
      const request = hub.requestBrowserApp(
        "attempt",
        "app",
        new Request("https://app.test/login", {
          headers: {
            authorization: "Bearer browser-app",
            cookie: "app_session=owned",
            origin: "https://app.test",
            accept: "application/json",
            connection: "keep-alive, x-hop",
            "x-hop": "must-not-forward",
            "keep-alive": "timeout=5",
            "proxy-authorization": "Bearer infrastructure",
            "proxy-connection": "keep-alive",
            forwarded: "host=foreign.test",
            "x-forwarded-host": "foreign.test",
            "x-forwarded-for": "127.0.0.1",
            "x-factory-runtime-attempt": "other",
            "ate-target-actor": "other/actor",
            host: "foreign.test",
          },
        }),
        "/login",
        async (send) => {
          expect(sent).toHaveLength(0);
          guarded = true;
          send();
        },
      );
      const frame = sent[0];
      expect(guarded).toBe(true);
      expect(frame).toMatchObject({
        type: "http-request",
        channel: "app",
        path: "/login",
        appAuthorization: "Bearer browser-app",
        headers: {
          accept: "application/json",
          cookie: "app_session=owned",
          origin: "https://app.test",
        },
      });
      expect(frame?.["headers"]).toEqual({
        accept: "application/json",
        cookie: "app_session=owned",
        origin: "https://app.test",
      });
      const streamId = frame?.["streamId"];
      hub.message(
        child,
        JSON.stringify({
          type: "http-response",
          streamId,
          status: 200,
          cookies: ["app_session=renewed; Path=/private; HttpOnly"],
        }),
      );
      hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
      const response = await request;
      expect(response.headers.getSetCookie()).toEqual([
        "app_session=renewed; Path=/private; HttpOnly",
      ]);
      expect(await response.text()).toBe("");
    } finally {
      hub.revoke("attempt");
    }
  });

  describe("isolated Browser App HTTP", () => {
    function finish({ hub, child, sent }: ReturnType<typeof fixture>) {
      const streamId = sent.findLast((frame) => frame["type"] === "http-request")?.["streamId"];
      hub.message(child, JSON.stringify({ type: "http-response", streamId, status: 204 }));
      hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
    }

    test.each(["source", "agent", "ide", "app-undeclared"])(
      "cannot request a non-App or undeclared channel: %s",
      async (channel) => {
        const { hub, sent, admit } = browserAppFixture();
        try {
          await expect(
            hub.requestBrowserApp("attempt", channel, new Request("https://app.test/"), "/", admit),
          ).rejects.toThrow("current declared App");
          expect(sent).toEqual([]);
        } finally {
          hub.revoke("attempt");
        }
      },
    );

    test.each(["unready replacement", "stopped", "failed"])(
      "requires a declaration from the current nonterminal Child: %s",
      async (state) => {
        const { hub, child, sent, admit } = browserAppFixture();
        try {
          if (state === "unready replacement") {
            hub.close(child);
            hub.open(connectorSocket("child"));
          } else hub.message(child, JSON.stringify({ type: "status", phase: state }));
          await expect(
            hub.requestBrowserApp("attempt", "app", new Request("https://app.test/"), "/", admit),
          ).rejects.toThrow("current declared App");
          expect(sent.some((frame) => frame["type"] === "http-request")).toBe(false);
        } finally {
          hub.revoke("attempt");
        }
      },
    );

    test.each(["/login", "/runtime/01994a7d-0000-7000-8000-000000000001/app/login"])(
      "ordinary request() still strips Factory authorization and cookies at %s",
      async (pathname) => {
        const value = browserAppFixture();
        const { hub, sent } = value;
        try {
          const response = hub.request(
            "attempt",
            "app",
            new Request(`https://factory.test${pathname}`, {
              headers: {
                authorization: "Bearer factory-secret",
                cookie: "factory.session_token=private; app_session=owned",
              },
            }),
            "/login",
          );
          expect(sent[0]).not.toHaveProperty("appAuthorization");
          expect(sent[0]?.["headers"]).not.toHaveProperty("authorization");
          expect(JSON.stringify(sent[0])).not.toContain("factory-secret");
          expect(JSON.stringify(sent[0])).not.toContain("private");
          finish(value);
          expect((await response).status).toBe(204);
        } finally {
          hub.revoke("attempt");
        }
      },
    );

    test("drops Connection-nominated credentials instead of treating them as end-to-end headers", async () => {
      const value = browserAppFixture();
      const { hub, sent, admit } = value;
      try {
        const response = hub.requestBrowserApp(
          "attempt",
          "app",
          new Request("https://app.test/", {
            headers: {
              connection: "Authorization, Cookie",
              authorization: "Bearer browser-app",
              cookie: "app_session=owned",
            },
          }),
          "/",
          admit,
        );
        expect(sent[0]?.["headers"]).toEqual({});
        expect(sent[0]).not.toHaveProperty("appAuthorization");
        finish(value);
        expect((await response).status).toBe(204);
      } finally {
        hub.revoke("attempt");
      }
    });

    test.each([
      ["authorization limit", { authorization: `Bearer ${"x".repeat((16 << 10) - 7)}` }],
      [
        "multibyte authorization limit",
        { authorization: `Basic ${"é".repeat(((16 << 10) - 6) / 2)}` },
      ],
      ["header byte limit", { cookie: "x".repeat((64 << 10) - 6) }],
      [
        "header count limit",
        Object.fromEntries(Array.from({ length: 128 }, (_, n) => [`x-app-${n}`, "owned"])),
      ],
    ] as Array<[string, Record<string, string>]>)(
      "accepts bounded credentials and headers: %s",
      async (_label, headers) => {
        const value = browserAppFixture();
        const { hub, sent, admit } = value;
        try {
          const response = hub.requestBrowserApp(
            "attempt",
            "app",
            new Request("https://app.test/", { headers }),
            "/",
            admit,
          );
          expect(sent[0]?.["appAuthorization"]).toBe(headers["authorization"]);
          finish(value);
          expect((await response).status).toBe(204);
        } finally {
          hub.revoke("attempt");
        }
      },
    );

    test.each([
      ["authorization bytes", { authorization: `Bearer ${"x".repeat(16 << 10)}` }],
      ["multibyte authorization bytes", { authorization: `Basic ${"é".repeat(8 << 10)}` }],
      ["authorization tab", { authorization: "Bearer browser\tapp" }],
      ["authorization control", { authorization: "Bearer browser-app\u001f" }],
      ["header bytes", { cookie: "x".repeat(64 << 10) }],
      [
        "header count",
        Object.fromEntries(Array.from({ length: 129 }, (_, n) => [`x-app-${n}`, "owned"])),
      ],
    ] as Array<[string, Record<string, string>]>)(
      "rejects oversized or malformed credentials before dispatch: %s",
      async (_label, headers) => {
        const { hub, sent, admit } = browserAppFixture();
        try {
          await expect(
            hub.requestBrowserApp(
              "attempt",
              "app",
              new Request("https://app.test/", { headers }),
              "/",
              admit,
            ),
          ).rejects.toThrow("Invalid Browser App");
          expect(sent.some((frame) => frame["type"] === "http-request")).toBe(false);
          expect(sent.at(-1)?.["type"]).toBe("stream-close");
        } finally {
          hub.revoke("attempt");
        }
      },
    );

    test("retains the request body bound without invoking admission", async () => {
      const { hub, sent } = browserAppFixture();
      try {
        const response = await hub.requestBrowserApp(
          "attempt",
          "app",
          new Request("https://app.test/", { method: "POST", body: "x".repeat((1 << 20) + 1) }),
          "/",
          async () => {
            throw new Error("Oversized body reached admission");
          },
        );
        expect(response.status).toBe(413);
        expect(sent).toEqual([]);
      } finally {
        hub.revoke("attempt");
      }
    });

    test.each([
      "abort",
      "suspend",
      "revoke",
      "replacement",
      "withdrawn",
      "owner revoked",
      "idle",
      "terminal status",
    ])("a held owner guard cannot dispatch after %s", async (boundary) => {
      let now = 0;
      const value = browserAppFixture(
        new RuntimeHub(
          async () => {},
          () => now,
        ),
      );
      const { hub, child, sent } = value;
      hub.open(connectorSocket("parent"));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const joined = Promise.withResolvers<void>();
      const abort = new AbortController();
      let permitted = true;
      const result = hub
        .requestBrowserApp(
          "attempt",
          "app",
          new Request("https://app.test/", {
            signal: abort.signal,
            headers: { authorization: "Bearer browser-app", cookie: "app_session=owned" },
          }),
          "/",
          async (send) => {
            entered.resolve();
            await release.promise;
            try {
              if (!permitted) throw new Error("Browser App owner changed");
              send();
            } finally {
              joined.resolve();
            }
          },
        )
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      try {
        await entered.promise;
        if (boundary === "abort") abort.abort();
        if (boundary === "suspend") hub.suspend("attempt");
        if (boundary === "revoke") hub.revoke("attempt");
        if (boundary === "replacement") {
          hub.close(child);
          hub.open(connectorSocket("child"));
        }
        if (boundary === "withdrawn")
          hub.message(child, JSON.stringify({ type: "hello", role: "child", channels: [] }));
        if (boundary === "owner revoked") permitted = false;
        if (boundary === "terminal status")
          hub.message(child, JSON.stringify({ type: "status", phase: "stopped" }));
        if (boundary === "idle") {
          now = 1000;
          expect(hub.claimIdle("attempt", 100)).toBe(true);
        }
        release.resolve();
        await joined.promise;
        expect(await result).toBeInstanceOf(Error);
        expect(sent.some((frame) => frame["type"] === "http-request")).toBe(false);
      } finally {
        release.resolve();
        hub.revoke("attempt");
        await joined.promise;
        await result;
      }
    });

    test("connection replacement during body consumption cannot reach either Child", async () => {
      const { hub, child, sent, admit } = browserAppFixture();
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      });
      const response = hub.requestBrowserApp(
        "attempt",
        "app",
        new Request("https://app.test/", { method: "POST", body }),
        "/",
        admit,
      );
      try {
        hub.close(child);
        const replacement = connectorSocket("child");
        replacement.send = child.send;
        hub.open(replacement);
        hub.message(
          replacement,
          JSON.stringify({
            type: "hello",
            role: "child",
            channels: [{ name: "app", kind: "app" }],
          }),
        );
        bodyController.close();
        await expect(response).rejects.toThrow("connection changed");
        expect(sent.some((frame) => frame["type"] === "http-request")).toBe(false);
      } finally {
        hub.revoke("attempt");
        await response.catch(() => undefined);
      }
    });
  });

  test.each([false, true])(
    "preserves separate response cookies and App isolation (origin scoped=%s)",
    async (originScoped) => {
      const { hub, child, sent } = fixture();
      const path = "/runtime/01994a7d-0000-7000-8000-000000000001/preview/app-forms";
      hub.message(
        child,
        JSON.stringify({
          type: "hello",
          role: "child",
          channels: [{ name: "app-forms", kind: "app" }],
        }),
      );
      try {
        const request = hub.request(
          "attempt",
          "app-forms",
          new Request(`https://app.test${path}/login`),
          "/login",
          undefined,
          undefined,
          originScoped,
        );
        const streamId = sent[0]?.["streamId"];
        hub.message(
          child,
          JSON.stringify({
            type: "http-response",
            streamId,
            status: 302,
            headers: { location: "/home" },
            cookies: [
              "starter.session_token=owned; Domain=foreign.test; Path=/private; HttpOnly",
              "theme=light; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
              "old_session=; Max-Age=0; Path=/old",
              "factory_runtime_access=forged; Path=/",
              "__Host-session=forged; Path=/; Secure",
            ],
          }),
        );
        hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
        const response = await request;
        const scope = `Path=${originScoped ? "/" : path}; SameSite=None; Secure; Partitioned`;
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/home");
        expect(response.headers.getSetCookie()).toEqual([
          `starter.session_token=owned; HttpOnly; ${scope}`,
          `theme=light; Expires=Wed, 21 Oct 2037 07:28:00 GMT; ${scope}`,
          `old_session=; Max-Age=0; ${scope}`,
        ]);
        expect(sent[0]).not.toHaveProperty("cookies");
        expect(await response.text()).toBe("");
      } finally {
        hub.revoke("attempt");
      }
    },
  );

  test.each([
    ["absent", undefined],
    ["empty", []],
    ["count limit", Array.from({ length: 128 }, (_, index) => `cookie${index}=owned`)],
    ["byte limit", [`large=${"x".repeat((64 << 10) - 6)}`]],
    [
      "aggregate byte limit",
      [`first=${"x".repeat((32 << 10) - 6)}`, `other=${"x".repeat((32 << 10) - 6)}`],
    ],
    ["multibyte byte limit", [`large=${"é".repeat(((64 << 10) - 6) / 2)}`]],
    ["duplicate names", ["session=first; Path=/first", "session=other; Path=/other"]],
    ["attribute tab", ["session=owned;\tPath=/"]],
  ] as const)("accepts response cookies at the wire bounds: %s", async (_label, cookies) => {
    const { hub, child, sent } = fixture();
    try {
      const request = hub.request(
        "attempt",
        "app",
        new Request("https://app.test/", { method: "HEAD" }),
        "/",
      );
      const streamId = sent[0]?.["streamId"];
      hub.message(
        child,
        JSON.stringify({
          type: "http-response",
          streamId,
          status: 204,
          headers: { "content-type": "text/plain" },
          cookies,
        }),
      );
      hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
      const response = await request;
      expect(response.headers.getSetCookie()).toEqual([...(cookies ?? [])]);
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(response.body).toBeNull();
    } finally {
      hub.revoke("attempt");
    }
  });

  test("the response cookie list replaces a flattened header instead of duplicating it", async () => {
    const { hub, child, sent } = fixture();
    try {
      const request = hub.request("attempt", "app", new Request("https://app.test/"), "/");
      const streamId = sent[0]?.["streamId"];
      hub.message(
        child,
        JSON.stringify({
          type: "http-response",
          streamId,
          status: 200,
          headers: { "Set-Cookie": "session=first" },
          cookies: ["session=first", "theme=light"],
        }),
      );
      hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
      const response = await request;
      expect(response.headers.getSetCookie()).toEqual(["session=first", "theme=light"]);
      expect(await response.text()).toBe("");
    } finally {
      hub.revoke("attempt");
    }
  });

  test.each([
    ["null", null],
    ["string", "session=owned"],
    ["object", { session: "owned" }],
    ["number", 1],
    ["mixed array", ["session=owned", 1]],
    ["nested array", [["session=owned"]]],
    ["null entry", [null]],
    ["object entry", [{ session: "owned" }]],
    ["empty header", [""]],
    ["count exceeded", Array.from({ length: 129 }, () => "session=owned")],
    ["byte limit exceeded", [`large=${"x".repeat(64 << 10)}`]],
    [
      "aggregate byte limit exceeded",
      [`first=${"x".repeat(32 << 10)}`, `other=${"x".repeat(32 << 10)}`],
    ],
    ["multibyte byte limit exceeded", [`large=${"é".repeat(32 << 10)}`]],
    ["CRLF injection", ["session=owned\r\nSet-Cookie: forged=owned"]],
    ["LF injection", ["session=owned\nforged=owned"]],
    ["NUL", ["session=owned\0"]],
    ["control character", ["session=owned\u001f"]],
    ["DEL", ["session=owned\u007f"]],
    ["non-byte header", ["session=owned\u0100"]],
  ])("rejects malformed or oversized response cookies: %s", async (_label, cookies) => {
    const { hub, child, sent } = fixture();
    try {
      const request = hub.request("attempt", "app", new Request("https://app.test/"), "/");
      const result = request.catch((cause: unknown) => cause);
      const streamId = sent[0]?.["streamId"];
      expect(() =>
        hub.message(
          child,
          JSON.stringify({ type: "http-response", streamId, status: 200, cookies }),
        ),
      ).not.toThrow();
      expect(await result).toEqual(new Error("Invalid runtime response"));
      expect(sent.at(-1)).toMatchObject({ type: "stream-close", streamId });
    } finally {
      hub.revoke("attempt");
    }
  });

  test("exposes headers and the first SSE chunk before the upstream ends", async () => {
    const { hub, child, sent } = fixture();
    let response: Response | undefined;
    const request = hub.request("attempt", "app", new Request("http://factory/events"), "/events");
    void request.then((value) => {
      response = value;
    });
    const streamId = sent[0]?.["streamId"];
    hub.message(
      child,
      JSON.stringify({
        type: "http-response",
        streamId,
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    hub.message(
      child,
      JSON.stringify({
        type: "stream-data",
        streamId,
        data: Buffer.from("data: first\n\n").toString("base64"),
      }),
    );
    await Bun.sleep(0);
    // Always settle the old implementation too, so a red test cannot leak its timeout.
    const streamed = response !== undefined;
    hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
    const completed = await request;
    expect(streamed).toBe(true);
    expect(await completed.text()).toBe("data: first\n\n");
  });

  test("cancelling a browser response closes the Connector stream", async () => {
    const { hub, child, sent } = fixture();
    const request = hub.request("attempt", "app", new Request("http://factory/events"), "/events");
    const streamId = sent[0]?.["streamId"];
    hub.message(
      child,
      JSON.stringify({ type: "http-response", streamId, status: 200, headers: {} }),
    );
    const response = await request;
    await response.body?.cancel();
    expect(sent.at(-1)).toMatchObject({ type: "stream-close", streamId });
  });

  test("fails a slow consumer instead of accumulating an unbounded queue", async () => {
    const { hub, child, sent } = fixture();
    const request = hub.request("attempt", "app", new Request("http://factory/events"), "/events");
    const streamId = sent[0]?.["streamId"];
    hub.message(
      child,
      JSON.stringify({ type: "http-response", streamId, status: 200, headers: {} }),
    );
    const response = await request;
    for (let index = 0; index < 33; index += 1) {
      hub.message(
        child,
        JSON.stringify({
          type: "stream-data",
          streamId,
          data: Buffer.alloc(32 << 10).toString("base64"),
        }),
      );
    }
    await expect(response.text()).rejects.toThrow("too slow");
    expect(sent.at(-1)).toMatchObject({ type: "stream-close", streamId });
  });

  test("HEAD responses have no body", async () => {
    const { hub, child, sent } = fixture();
    const request = hub.request(
      "attempt",
      "app",
      new Request("http://factory/", { method: "HEAD" }),
      "/",
    );
    const streamId = sent[0]?.["streamId"];
    hub.message(
      child,
      JSON.stringify({ type: "http-response", streamId, status: 200, headers: {} }),
    );
    hub.message(child, JSON.stringify({ type: "stream-end", streamId }));
    expect((await request).body).toBeNull();
  });

  test.each(["abort", "suspend"] as const)(
    "a held admission guard settles %s immediately and cannot forward afterward",
    async (failure) => {
      const { hub, sent } = fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const joined = Promise.withResolvers<void>();
      const abort = new AbortController();
      const response = hub
        .request(
          "attempt",
          "agent",
          new Request("http://factory/prompt", {
            method: "POST",
            body: "{}",
            signal: abort.signal,
          }),
          "/prompt",
          async (send) => {
            entered.resolve();
            await release.promise;
            try {
              send();
            } finally {
              joined.resolve();
            }
          },
        )
        .then(
          () => "sent",
          () => "rejected",
        );
      try {
        await entered.promise;
        if (failure === "abort") abort.abort();
        else hub.suspend("attempt");
        expect(await Promise.race([response, Bun.sleep(100).then(() => "hung")])).toBe("rejected");
        release.resolve();
        await joined.promise;
        expect(sent.some((frame) => frame["type"] === "http-request")).toBe(false);
      } finally {
        release.resolve();
        hub.suspend("attempt");
        await response;
        await joined.promise;
      }
    },
  );
});
