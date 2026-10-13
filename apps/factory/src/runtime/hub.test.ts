import { describe, expect, test } from "bun:test";
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

function connectorSocket(role: "parent" | "child") {
  return {
    data: { kind: "connector", role, attemptID: "attempt", generation: 1 },
    close() {},
    send() {
      return 1;
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
}

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

test("idle admission retains detached PTYs, active views and unknown/stale terminal observations", async () => {
  let now = 0;
  const hub = new RuntimeHub(
    async () => {},
    () => now,
  );
  const parent = connectorSocket("parent");
  const child = connectorSocket("child");
  hub.open(parent);
  hub.open(child);
  const observe = (terminalCount: number, terminalRevision: number) =>
    hub.message(child, JSON.stringify({ type: "terminal-state", terminalCount, terminalRevision }));
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
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    await view.body?.cancel();
    expect(hub.claimIdle("attempt", 100)).toBe(true);
    expect((await hub.request("attempt", "app", new Request("http://app/"), "/")).status).toBe(503);
    await expect(
      hub.childOperation("attempt", { operationId: "late", action: "process-start" }),
    ).rejects.toThrow("stopping");
    hub.releaseIdle("attempt");
    expect(hub.claimIdle("attempt", 100)).toBe(false);
    now = 4000;
    expect(hub.claimIdle("attempt", 100)).toBe(true);
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
      `starter.session_token=app; HttpOnly; SameSite=Lax; Path=${path}`,
      `theme=light; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=${path}`,
    ]);
    expect(() => scopeAppCookies(new Response(), "/")).toThrow("scoped");
  });
  test("App requests retain their cookies and exact proxy path without Factory credentials or spoofed proxy headers", () => {
    const id = crypto.randomUUID();
    const host = `${id.replaceAll("-", "")}.app.runtime.localhost:3000`;
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
});

describe("Runtime terminal attachment readiness", () => {
  test("App sockets keep scoped cookies and the requested native protocol without upgrade credentials", () => {
    const id = crypto.randomUUID();
    const prefix = `/runtime/${id}/app`;
    const request = new Request(
      `http://${id.replaceAll("-", "")}.app.runtime.localhost:3000${prefix}/?token=hmr`,
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
  function fixture() {
    const sent: Array<Record<string, string>> = [];
    const child = connectorSocket("child");
    child.send = (raw) => {
      sent.push(JSON.parse(String(raw)));
      return 1;
    };
    const hub = new RuntimeHub(async () => {});
    hub.open(child);
    return { hub, child, sent };
  }

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
