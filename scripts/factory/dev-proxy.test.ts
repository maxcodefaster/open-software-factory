import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "vite";

const ClientSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

test("the actual dev config strips TypeScript, proxies authenticated commands and preserves origin fences for API and Zero", async () => {
  const cache = await mkdtemp(resolve(tmpdir(), "factory-dev-proxy-"));
  const previous = process.env["FACTORY_DEV_BACKEND_URL"];
  let planningOrigin = "";
  let backendOrigin = "";
  const zero = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      planningOrigin = request.headers.get("origin") ?? "";
      if (planningOrigin !== backendOrigin) return new Response(null, { status: 403 });
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/health/ready")
        return Response.json({ ready: true, planningCacheURL: zero.url.origin });
      if (request.headers.get("origin") !== backendOrigin)
        return new Response(null, { status: 403 });
      return Response.json({ cookie: request.headers.get("cookie") });
    },
  });
  backendOrigin = backend.url.origin;
  process.env["FACTORY_DEV_BACKEND_URL"] = backendOrigin;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let socket: WebSocket | undefined;
  try {
    server = await createServer({
      configFile: resolve("apps/factory/vite.config.ts"),
      cacheDir: cache,
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing dev listener");
    const base = `http://127.0.0.1:${address.port}`;
    const readiness = await fetch(`${base}/health/ready`);
    expect(readiness.headers.get("content-type")).toContain("application/json");
    expect(await readiness.json()).toEqual({
      ready: true,
      planningCacheURL: zero.url.origin,
    });
    const source = await (await fetch(`${base}/src/factory-entry.tsx`)).text();
    expect(source).not.toContain("createSignal<Bootstrap>");
    const allowed = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { origin: base, cookie: "owned-dev-session=fixture" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ cookie: "owned-dev-session=fixture" });
    const serverFunction = await fetch(`${base}/_server/data/owned-fixture`, {
      method: "POST",
      headers: { origin: base, cookie: "owned-dev-session=fixture" },
    });
    expect(serverFunction.status).toBe(200);
    expect(await serverFunction.json()).toEqual({ cookie: "owned-dev-session=fixture" });
    expect(
      (
        await fetch(`${base}/_server/data/owned-fixture`, {
          method: "POST",
          headers: { origin: "https://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/echo`, {
          method: "POST",
          headers: { origin: "https://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    const echoed = Promise.withResolvers<string>();
    socket = new ClientSocket(`${base.replace("http:", "ws:")}/__factory_zero/zero`, {
      headers: { origin: base },
    });
    socket.onopen = () => socket!.send("owned-planning-mutation");
    socket.onmessage = (event) => echoed.resolve(String(event.data));
    socket.onerror = () => echoed.reject(new Error("Planning proxy connection failed"));
    expect(await echoed.promise).toBe("owned-planning-mutation");
    expect(planningOrigin).toBe(backendOrigin);
    socket.close();
    const denied = Promise.withResolvers<void>();
    socket = new ClientSocket(`${base.replace("http:", "ws:")}/__factory_zero/zero`, {
      headers: { origin: "https://foreign.invalid" },
    });
    socket.onopen = () => denied.reject(new Error("Foreign WebSocket origin was admitted"));
    socket.onerror = () => denied.resolve();
    socket.onclose = () => denied.resolve();
    await denied.promise;
  } finally {
    socket?.close();
    await server?.close();
    await backend.stop(true);
    await zero.stop(true);
    await rm(cache, { recursive: true, force: true });
    if (previous === undefined) delete process.env["FACTORY_DEV_BACKEND_URL"];
    else process.env["FACTORY_DEV_BACKEND_URL"] = previous;
  }
}, 20_000);
