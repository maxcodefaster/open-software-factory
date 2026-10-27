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
const allow = () => hub.allow(attemptID, 1, hash(`${owner}-parent`), hash(`${owner}-child`));
allow();
const prepared = Promise.withResolvers<void>();
let terminal: WebSocket | undefined;
let terminalReady = false;
let terminalOutput = "";
async function terminalProbe(phase: "BEFORE" | "AFTER") {
  if (!terminal || terminal.readyState > WebSocket.OPEN) {
    terminalReady = false;
    terminalOutput = "";
    terminal = new WebSocket(`ws://127.0.0.1:18181/terminal?owner=${owner}`);
    terminal.binaryType = "arraybuffer";
    terminal.onmessage = (event) => {
      if (typeof event.data === "string" && event.data.includes('"type":"terminal-ready"'))
        terminalReady = true;
      else terminalOutput = (terminalOutput + Buffer.from(event.data).toString()).slice(-16_384);
    };
  }
  const deadline = performance.now() + 8_000;
  while (!terminalReady && performance.now() < deadline) await Bun.sleep(20);
  if (!terminalReady) throw new Error("Native terminal attachment did not become ready");
  const command =
    (phase === "BEFORE" ? `export FACTORY_NATIVE_NONCE=${owner}; ` : "") +
    `printf 'FACTORY_NATIVE_${phase}=%s:%s\\n' "$$" "$FACTORY_NATIVE_NONCE"\n`;
  terminal.send(new TextEncoder().encode(command));
  const pattern = new RegExp(`FACTORY_NATIVE_${phase}=(\\d+):(${owner})`);
  while (performance.now() < deadline) {
    const observed = terminalOutput.match(pattern);
    if (observed) return { pid: Number(observed[1]), nonce: observed[2] };
    await Bun.sleep(20);
  }
  throw new Error("Native terminal did not retain its shell state");
}
async function gitProbe(commit = false) {
  const operation = async (input: Readonly<Record<string, string>>) => {
    const result = await hub.parentOperation(attemptID, {
      operationId: crypto.randomUUID(),
      action: "workspace-git",
      data: JSON.stringify({ branch: "main", ...input }),
    });
    return JSON.parse(result.data ?? "null") as { head: string; branch: string; files: unknown[] };
  };
  const before = await operation({ action: "status" });
  return commit
    ? operation({
        action: "commit",
        expectedHead: before.head,
        message: "Owned native personal Git proof",
        authorName: "Native Factory fixture",
        authorEmail: "native@factory.invalid",
      })
    : before;
}
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
    if (path === "/terminal" && new URL(request.url).searchParams.get("owner") === owner) {
      if (
        server.upgrade(request, {
          data: { kind: "browser", attemptID, channel: "terminal", path: "/native-idle" },
        })
      )
        return;
      return new Response("Upgrade failed", { status: 500 });
    }
    if (request.headers.get("x-fixture-owner") !== owner)
      return new Response("Unauthorized", { status: 401 });
    if (path === "/terminal/before" && request.method === "POST")
      return Response.json(await terminalProbe("BEFORE"));
    if (path === "/terminal/after" && request.method === "POST")
      return Response.json(await terminalProbe("AFTER"));
    if (path === "/git-status") return Response.json(await gitProbe());
    if (path === "/git-commit" && request.method === "POST")
      return Response.json(await gitProbe(true));
    if (path === "/idle") {
      const eligible = hub.claimIdle(attemptID, 0);
      if (eligible) hub.releaseIdle(attemptID);
      return Response.json({ eligible });
    }
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
