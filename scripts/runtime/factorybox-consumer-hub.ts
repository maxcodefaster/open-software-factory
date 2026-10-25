// Owned native acceptance endpoint. This is never part of the product server.
import { createHash } from "node:crypto";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";

const owner = process.argv[2] ?? "";
const attemptID = process.argv[3] ?? "";
if (!/^[a-f0-9]{32}$/.test(owner) || !/^[a-f0-9-]{36}$/.test(attemptID))
  throw new Error("Native consumer fixture requires exact ownership");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const events: Array<{ phase: string; error?: string }> = [];
const hub = new RuntimeHub(async (_id, phase, error) => {
  events.push({ phase, ...(error ? { error } : {}) });
  if (events.length > 500) events.shift();
});
const allow = () => hub.allow(attemptID, 1, hash(owner + "-parent"), hash(owner + "-child"));
allow();
const prepared = Promise.withResolvers<void>();
Bun.serve<RuntimeSocketData>({
  hostname: "0.0.0.0",
  port: 18181,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/internal/runtime-connect") {
      await prepared.promise;
      const data = hub.authorize(request, hash);
      if (!data) return new Response("Unauthorized", { status: 401 });
      if (
        server.upgrade(request, {
          data,
          headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
        })
      )
        return;
      return new Response("Upgrade failed", { status: 500 });
    }
    if (request.headers.get("x-fixture-owner") !== owner)
      return new Response("Unauthorized", { status: 401 });
    if (path === "/prepared" && request.method === "POST") prepared.resolve();
    if (path === "/pause" && request.method === "POST") hub.revoke(attemptID);
    if (path === "/resume" && request.method === "POST") allow();
    if (path === "/app") return hub.request(attemptID, "app", request, "/");
    return Response.json({
      connected: hub.connected(attemptID),
      events,
      processes: hub.processes(attemptID),
    });
  },
  websocket: {
    open: (socket) => hub.open(socket),
    message: (socket, message) => hub.message(socket, message),
    close: (socket) => hub.close(socket),
  },
});
