import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { RuntimeSocketData } from "../runtime/hub";
import { createRuntimeProtocol } from "./protocols/runtime";
import { startFactoryTransport } from "./transport";

const id = "01994a7d-0000-7000-8000-000000000001";
const hex = id.replaceAll("-", "");
const origin = "https://factory.example";

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
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'sha256-");
  const body = await response.text();
  expect(body).toContain("factory-preview-document-failed");
  expect(body).not.toContain("Factory command failed");
  expect(body).not.toContain("channel request failed");
});

test("isolated App origins serve root pages, assets, APIs and sockets without entering Factory", async () => {
  let factoryCalls = 0;
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
        request.headers.get("cookie") === `factory_runtime_access=${app}`
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
      hasAppChannel: (_attempt: string, channel: string) => ["app", "app-forms"].includes(channel),
      request: async (_attempt: string, app: string, request: Request, path: string) =>
        Response.json({ app, path, method: request.method, body: await request.text() }),
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
  process.env["FACTORY_PORT"] = "0";
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
        "/rund-ums-fahrzeug/elektromobilitaet/",
        "/@vite/client",
        "/fonts/app.woff2",
        "/api/session",
        "/_server/data/app",
      ]) {
        const response = await fetch(`${base}${path}?q=one`, {
          headers: { host, cookie: `factory_runtime_access=${app}` },
        });
        expect(response.status, `${app} ${path}`).toBe(200);
        expect(await response.json()).toMatchObject({ app, path: `${path}?q=one` });
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
        app,
        path: "/api/submit",
        method: "POST",
        body: "retained App request",
      });
    }
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
      });
    } finally {
      socket.close();
    }
    expect(factoryCalls).toBe(0);
    expect((await fetch(`${base}/`, { headers: { host: "factory.example" } })).status).toBe(403);
    expect(factoryCalls).toBe(1);
  } finally {
    for (const server of servers) await server.stop(true);
  }
}, 10_000);
