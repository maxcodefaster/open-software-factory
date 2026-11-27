import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { RuntimeHub, type RuntimeSocketData } from "../runtime/hub";
import { createApiProtocol } from "./protocols/api";
import { createRuntimeProtocol } from "./protocols/runtime";
import { startFactoryTransport } from "./transport";

const id = "01994a7d-0000-7000-8000-000000000001";
const hex = id.replaceAll("-", "");
const origin = "https://factory.example";

test("App grants open customer paths at the isolated origin root without a Factory router prefix", async () => {
  const authorized: unknown[] = [];
  const grants: unknown[] = [];
  const services = {
    factoryOrigin: origin,
    requireSession: async () => ({ user: { id: "actor" }, session: { id: "session" } }),
    accessController: {
      authorizeAPI: async () => {},
      requireRuntime: async (...args: unknown[]) => {
        authorized.push(args);
      },
    },
    mcpOAuthCallback: async () => undefined,
    forgeIdentityRoutes: async () => undefined,
    reviewMediaRoutes: async () => undefined,
    sourceProtocol: async () => undefined,
    demandRuntime: async () => true,
    runtimeReady: async () => true,
    runtimeHub: { hasAppChannel: () => true },
    runtimeAccess: {
      issue: async (input: unknown) => {
        grants.push(input);
        return "owned";
      },
    },
  } as unknown as Parameters<typeof createApiProtocol>[0];
  const api = createApiProtocol(services);
  for (const [route, suffix, channel] of [
    ["app", "/", "app"],
    ["preview/app", "/", "app"],
    ["preview/app-forms", "/drafts/owned?revision=1&route=%2Fforms%2F", "app-forms"],
    ["ide", "/", "ide"],
  ]) {
    const path = `/runtime/${id}/${route}${suffix}`;
    const response = await api(
      new Request(`${origin}/api/runtime-access?${new URLSearchParams({ path, embed: "1" })}`),
    );
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("location") ?? "");
    expect(destination.hostname).toBe(
      `${hex}${channel === "app-forms" ? "app-forms" : `-${channel}`}.runtime.factory.example`,
    );
    expect(destination.pathname).toBe(
      channel === "ide" ? `/runtime/${id}/ide/` : new URL(suffix!, origin).pathname,
    );
    expect(destination.searchParams.get("factory-grant")).toBe("owned");
    if (channel === "app-forms") {
      expect(destination.searchParams.get("revision")).toBe("1");
      expect(destination.searchParams.get("route")).toBe("/forms/");
    }
    expect(authorized.at(-1)).toEqual(["actor", id, channel === "ide" ? "ide" : "app"]);
    expect(grants.at(-1)).toMatchObject({
      attemptID: id,
      userID: "actor",
      sessionID: "session",
      mode: "embedded",
    });
  }
});

test("a failed Preview navigation reports attachment failure instead of displaying Factory JSON", async () => {
  const services = {
    factoryOrigin: origin,
    runtimeReady: async () => true,
    demandRuntime: async () => true,
    runtimeAccess: {
      user: async () => "actor",
      authorize: async () => "owned-access",
      redeem: async () => undefined,
    },
    runtimeHub: {
      hasAppChannel: () => true,
      request: async () => {
        throw new Error("channel request failed");
      },
    },
  } as unknown as Parameters<typeof createRuntimeProtocol>[0];
  const request = new Request(`${origin}/runtime/${id}/preview/app/`, {
    headers: { "sec-fetch-mode": "navigate" },
  });
  const response = await createRuntimeProtocol(services)(request);
  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'sha256-");
  const body = await response.text();
  expect(body).toContain("factory-preview-document-failed");
  expect(body).not.toContain("Factory command failed");
  expect(body).not.toContain("channel request failed");
});

test("isolated App origins serve root pages, assets, APIs and sockets without entering Factory", async () => {
  let factoryCalls = 0;
  const hub = new RuntimeHub(async () => {});
  const child = {
    data: { kind: "connector", role: "child", attemptID: id, generation: 1 },
    close() {},
    send(raw: string) {
      const frame = JSON.parse(String(raw));
      if (frame.type !== "http-request") return 1;
      hub.message(
        child,
        JSON.stringify({
          type: "http-response",
          streamId: frame.streamId,
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      hub.message(
        child,
        JSON.stringify({
          type: "stream-data",
          streamId: frame.streamId,
          data: Buffer.from(
            JSON.stringify({
              attemptID: id,
              app: frame.channel,
              path: frame.path,
              method: frame.method,
              body: Buffer.from(frame.data, "base64").toString(),
              headers: frame.headers,
            }),
          ).toString("base64"),
        }),
      );
      hub.message(child, JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
      return 1;
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  hub.open(child);
  hub.message(
    child,
    JSON.stringify({
      type: "hello",
      role: "child",
      channels: [
        { name: "app", kind: "app" },
        { name: "app-forms", kind: "app" },
      ],
    }),
  );
  const services = {
    factoryHost: "127.0.0.1",
    factoryOrigin: origin,
    developerIDEEdge: { matches: () => false },
    runtimeReady: async () => true,
    demandRuntime: async () => true,
    runtimeAccess: {
      has: () => true,
      user: async () => "actor",
      authorize: async (request: Request, attempt: string, role: string, app = "app") =>
        attempt === id &&
        role === "app" &&
        request.headers
          .get("cookie")
          ?.split(";")
          .some((value) => value.trim() === `factory_runtime_access=${app}`)
          ? app
          : undefined,
      redeem: async (url: URL, _attempt: string, _role: string, cookiePath: string) =>
        url.searchParams.get("factory-grant") === "owned"
          ? new Response(null, {
              status: 302,
              headers: { "set-cookie": `owned=1; Path=${cookiePath}` },
            })
          : undefined,
    },
    runtimeHub: {
      hasAppChannel: hub.hasAppChannel.bind(hub),
      request: hub.request.bind(hub),
      open: (socket: ServerWebSocket<RuntimeSocketData>) =>
        socket.send(JSON.stringify(socket.data)),
      close: () => {},
      message: () => {},
    },
    staticAssets: () => {
      factoryCalls++;
      return new Response("Factory document", { status: 403 });
    },
    serverFunctionEndpoint: () => {
      factoryCalls++;
      return new Response("Factory command", { status: 403 });
    },
    startFetch: (request: Request) => createRuntimeProtocol(services)(request),
  } as unknown as Parameters<typeof startFactoryTransport>[0];
  const previous = process.env["FACTORY_PORT"];
  const previousBaseURL = process.env["FACTORY_BASE_URL"];
  process.env["FACTORY_PORT"] = "0";
  process.env["FACTORY_BASE_URL"] = origin;
  const servers = startFactoryTransport(services);
  if (previous === undefined) delete process.env["FACTORY_PORT"];
  else process.env["FACTORY_PORT"] = previous;
  try {
    const base = `http://127.0.0.1:${servers[0]?.port}`;
    for (const [app, host] of [
      ["app", `${hex}-app.runtime.factory.example`],
      ["app-forms", `${hex}app-forms.runtime.factory.example`],
    ] as const) {
      for (const path of [
        "/",
        "/rund-ums-fahrzeug/elektromobilitaet/",
        "/@vite/client",
        "/fonts/app.woff2",
        "/api/session",
        "/_server/data/app",
      ]) {
        const response = await fetch(`${base}${path}?q=one`, {
          headers: {
            host,
            origin: `https://${host}`,
            cookie: `factory_runtime_access=${app}; starter.session_token=owned`,
            authorization: "Bearer factory-secret",
            forwarded: "host=spoofed.test;proto=http",
            "x-forwarded-host": "spoofed.test",
            "x-forwarded-proto": "http",
            "x-forwarded-prefix": "/spoofed",
          },
        });
        expect(response.status, `${app} ${path}`).toBe(200);
        const forwarded = await response.json();
        expect(forwarded).toMatchObject({
          attemptID: id,
          app,
          path: `${path}?q=one`,
          headers: {
            "x-forwarded-host": host,
            "x-forwarded-proto": "https",
            "x-forwarded-prefix": "",
            origin: `https://${host}`,
            cookie: "starter.session_token=owned",
          },
        });
        for (const name of ["authorization", "host", "forwarded"])
          expect(forwarded.headers).not.toHaveProperty(name);
      }
      const grant = await fetch(`${base}/runtime/${id}/preview/${app}/?factory-grant=owned`, {
        headers: { host },
        redirect: "manual",
      });
      expect(grant.status).toBe(302);
      expect(grant.headers.get("set-cookie")).toContain("Path=/");
      expect(grant.headers.get("set-cookie")).not.toContain("Path=/runtime/");
      const denied = await fetch(`${base}/api/private`, { headers: { host } });
      expect(denied.status).toBe(401);
      const draftPath = "/forms-preview/drafts/owned?revision=1&route=%2Fforms%2F";
      const navigation = await fetch(`${base}${draftPath}`, {
        headers: { host, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
        redirect: "manual",
      });
      expect(navigation.status).toBe(302);
      const access = new URL(navigation.headers.get("location") ?? "https://missing.invalid");
      expect(access.origin).toBe(origin);
      expect(access.pathname).toBe("/api/runtime-access");
      expect(access.searchParams.get("path")).toBe(`/runtime/${id}/preview/${app}${draftPath}`);
      expect(access.searchParams.has("embed")).toBe(false);
      expect(navigation.headers.get("set-cookie")).toBeNull();
      expect(navigation.headers.get("cache-control")).toContain("no-store");
      expect(navigation.headers.get("referrer-policy")).toBe("no-referrer");
      for (const [mode, destination, method] of [
        ["navigate", "iframe", "GET"],
        ["cors", "document", "GET"],
        ["navigate", "document", "POST"],
      ] as const) {
        const blocked = await fetch(`${base}${draftPath}`, {
          method,
          headers: { host, "sec-fetch-mode": mode, "sec-fetch-dest": destination },
          redirect: "manual",
        });
        expect(blocked.status).toBe(401);
        expect(blocked.headers.get("location")).toBeNull();
      }
      const invalidGrant = await fetch(`${base}/?factory-grant=invalid`, {
        headers: { host, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
        redirect: "manual",
      });
      expect(invalidGrant.status).toBe(401);
      if (app === "app-forms") {
        expect(
          (
            await fetch(`${base}/api/private`, {
              headers: { host, cookie: "factory_runtime_access=app" },
            })
          ).status,
        ).toBe(401);
      }
      const submitted = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { host, cookie: `factory_runtime_access=${app}` },
        body: "retained App request",
      });
      expect(submitted.status).toBe(200);
      expect(await submitted.json()).toMatchObject({
        attemptID: id,
        app,
        path: "/api/submit",
        method: "POST",
        body: "retained App request",
      });
    }
    for (const host of [
      "factory.example",
      "foreign.example",
      `${hex}-app.runtime.factory.example.evil.test`,
    ]) {
      const prefix = `/runtime/${id}/preview/app`;
      const response = await fetch(`${base}${prefix}/@vite/client?route=%2Fforms%2F`, {
        headers: {
          host,
          cookie: "factory_runtime_access=app",
          "x-forwarded-host": `${hex}-app.runtime.factory.example`,
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        attemptID: id,
        app: "app",
        path: "/@vite/client?route=%2Fforms%2F",
        headers: {
          "x-forwarded-host": host,
          "x-forwarded-proto": host === "factory.example" ? "https" : "http",
          "x-forwarded-prefix": prefix,
        },
      });
    }
    const otherAttempt = "01994a7d000070008000000000000002-app.runtime.factory.example";
    expect(
      (
        await fetch(`${base}/?q=original`, {
          headers: {
            host: otherAttempt,
            cookie: "factory_runtime_access=app",
            "x-forwarded-host": `${hex}-app.runtime.factory.example`,
          },
        })
      ).status,
    ).toBe(401);
    const ide = await fetch(`${base}/runtime/${id}/ide/`, {
      headers: {
        host: "factory.example",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
      redirect: "manual",
    });
    expect(ide.status).toBe(401);
    expect(ide.headers.get("location")).toBeNull();
    const socket = new (
      WebSocket as typeof WebSocket & {
        new (url: string, options: Bun.WebSocketOptions & { protocols: string[] }): WebSocket;
      }
    )(`${base.replace("http:", "ws:")}/?token=hmr`, {
      protocols: ["vite-hmr"],
      headers: {
        host: `${hex}app-forms.runtime.factory.example`,
        cookie: "factory_runtime_access=app-forms",
        origin: `https://${hex}app-forms.runtime.factory.example`,
      },
    });
    try {
      const message = await new Promise<string>((resolve, reject) => {
        socket.onmessage = (event) => resolve(String(event.data));
        socket.onerror = () => reject(new Error("Root App socket failed"));
        socket.onclose = () => reject(new Error("Root App socket closed before attachment"));
      });
      expect(JSON.parse(message)).toMatchObject({
        attemptID: id,
        channel: "app-forms",
        path: "/?token=hmr",
        protocol: "vite-hmr",
        headers: {
          "x-forwarded-host": `${hex}app-forms.runtime.factory.example`,
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "",
          origin: `https://${hex}app-forms.runtime.factory.example`,
        },
      });
    } finally {
      socket.close();
    }
    for (const [host, channel, mount, expectedPrefix, proto] of [
      [`${hex}-app.runtime.factory.example`, "app", `/runtime/${id}/app`, "", "https"],
      [
        `${hex}app-forms.runtime.factory.example`,
        "app-forms",
        `/runtime/${id}/preview/app-forms`,
        "",
        "https",
      ],
      ["factory.example", "app", `/runtime/${id}/app`, `/runtime/${id}/app`, "https"],
      [
        "foreign.example",
        "app",
        `/runtime/${id}/preview/app`,
        `/runtime/${id}/preview/app`,
        "http",
      ],
    ] as const) {
      const path = "/@vite/client?token=hmr&route=%2Fforms%2F";
      const mountedSocket = new (
        WebSocket as typeof WebSocket & {
          new (url: string, options: Bun.WebSocketOptions & { protocols: string[] }): WebSocket;
        }
      )(`${base.replace("http:", "ws:")}${mount}${path}`, {
        protocols: ["vite-hmr"],
        headers: {
          host,
          cookie: `factory_runtime_access=${channel}; starter.session_token=app`,
          origin: `https://${host}`,
          authorization: "Bearer factory-secret",
          forwarded: "host=spoofed.test;proto=https",
          "x-forwarded-host": `${hex}-app.runtime.factory.example`,
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "/spoofed",
        },
      });
      try {
        const message = await new Promise<string>((resolve, reject) => {
          mountedSocket.onmessage = (event) => resolve(String(event.data));
          mountedSocket.onerror = () => reject(new Error("Mounted App socket failed"));
          mountedSocket.onclose = () => reject(new Error("Mounted App socket closed"));
        });
        const forwarded = JSON.parse(message);
        expect(forwarded).toMatchObject({
          attemptID: id,
          channel,
          path,
          protocol: "vite-hmr",
          headers: {
            "x-forwarded-host": host,
            "x-forwarded-proto": proto,
            "x-forwarded-prefix": expectedPrefix,
            cookie: "starter.session_token=app",
          },
        });
        expect(forwarded.headers.origin).toBe(proto === "https" ? `https://${host}` : undefined);
        for (const name of ["authorization", "host", "forwarded", "sec-websocket-key"])
          expect(forwarded.headers).not.toHaveProperty(name);
      } finally {
        mountedSocket.close();
      }
    }
    expect(factoryCalls).toBe(0);
    expect((await fetch(`${base}/`, { headers: { host: "factory.example" } })).status).toBe(403);
    expect(factoryCalls).toBe(1);
  } finally {
    hub.revoke(id);
    for (const server of servers) await server.stop(true);
    if (previousBaseURL === undefined) delete process.env["FACTORY_BASE_URL"];
    else process.env["FACTORY_BASE_URL"] = previousBaseURL;
  }
}, 10_000);
