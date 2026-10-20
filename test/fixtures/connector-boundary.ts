import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { createOpenCodeClient } from "../../apps/factory/src/agent/opencode-client";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { observe, type pinnedOpenCode } from "./pinned-opencode";

type Loss = "none" | "stream-close" | "reconnect";

// fetch has already decoded the body. Do not serve it with the upstream wire
// encoding or length: the native Go client would try to decode it again.
function forwardedResponse(response: Response, body: BodyInit | null = response.body) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}

async function cleanupDeadline(work: Promise<unknown>, stage: string) {
  let timer: Timer | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned Connector ${stage} did not stop`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Actual Factory HTTP/WebSocket forwarding and the source-built Go child, with
// a held local HTTP hop before the unmodified pinned OpenCode process admits input.
export async function connectorBoundary(
  process: Awaited<ReturnType<typeof pinnedOpenCode>>,
  attemptID = crypto.randomUUID(),
) {
  const binary = resolve(process.scratch, "owned-connector");
  const build = Bun.spawn(["go", "build", "-o", binary, "./cmd/factory-runtime-connector"], {
    cwd: resolve("services/runtime-connector"),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [buildError, buildStatus] = await Promise.all([
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (buildStatus !== 0) throw new Error(`Owned Connector build failed: ${buildError}`);
  const token = crypto.randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const hub = new RuntimeHub(async () => {});
  hub.allow(attemptID, 1, hash(token), hash(token));
  let child: ServerWebSocket<RuntimeSocketData> | undefined;
  const sockets = new Set<ServerWebSocket<RuntimeSocketData>>();
  let connections = 0;
  let held:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
        admitted: boolean;
        interrupted: ReturnType<typeof Promise.withResolvers<boolean>>;
        mutation: "prompt" | "session-create";
      }
    | undefined;
  let heldRead:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      const reading = heldRead;
      if (request.method === "GET" && url.pathname.endsWith("/message") && reading) {
        reading.entered.resolve();
        await reading.release.promise;
        if (request.signal.aborted) return new Response(null, { status: 499 });
        return forwardedResponse(await process.transport(request, path));
      }
      const current = held;
      if (
        request.method === "POST" &&
        current &&
        (current.mutation === "prompt" ? path.endsWith("/prompt") : path === "/api/session")
      ) {
        const body = await request.arrayBuffer();
        current.entered.resolve();
        // Do not propagate browser/control loss as proof of upstream rejection.
        await current.release.promise;
        const response = await process.transport(
          new Request(request.url, { method: "POST", headers: request.headers, body }),
          path,
        );
        const admitted = await response.arrayBuffer();
        if (!response.ok) throw new Error("Owned delayed OpenCode admission failed");
        current.admitted = true;
        return forwardedResponse(response, admitted);
      }
      if (request.method === "POST" && path.endsWith("/interrupt") && current) {
        current.interrupted.resolve(!current.admitted);
      }
      return forwardedResponse(await process.transport(request, path));
    },
  });
  let control: Bun.Server<RuntimeSocketData> | undefined;
  let connector: ReturnType<typeof Bun.spawn> | undefined;
  async function dispose() {
    held?.release.resolve();
    heldRead?.release.resolve();
    try {
      connector?.kill("SIGTERM");
      if (connector) await cleanupDeadline(connector.exited, "child");
    } finally {
      // A child-join failure must still close the servers and reach the outer
      // owner-checked OpenCode disposal. Kill only this fixture's child handle.
      if (connector?.exitCode === null) connector.kill("SIGKILL");
      hub.revoke(attemptID);
      for (const socket of sockets) socket.terminate();
      await cleanupDeadline(Promise.all([control?.stop(true), proxy.stop(true)]), "servers");
    }
  }
  const assignment = resolve(process.scratch, "connector-assignment.json");
  try {
    control = Bun.serve<RuntimeSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const data = hub.authorize(request, hash);
        if (!data) return new Response(null, { status: 401 });
        if (
          server.upgrade(request, {
            data,
            headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
          })
        )
          return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          sockets.add(socket);
          hub.open(socket);
          child = socket;
        },
        message(socket, message) {
          hub.message(socket, message);
          if (JSON.parse(String(message)).type === "hello") connections += 1;
        },
        close(socket) {
          sockets.delete(socket);
          hub.close(socket);
          // This fixture has no parent process. Release pending HTTP as the
          // production Hub does when the other role stays connected.
          hub.suspend(attemptID);
          if (child === socket) child = undefined;
        },
      },
    });
    await Bun.write(
      assignment,
      JSON.stringify({
        version: 1,
        runtimeAttemptId: attemptID,
        generation: 1,
        workspaceFolder: resolve(process.scratch, "project"),
        remoteWorkspaceFolder: "/workspace/project",
        repositoryUrl: "https://example.invalid/owned-connector.git",
        repositoryIdentity: "owned-connector",
        revision: "main",
        devcontainerPath: ".devcontainer/devcontainer.json",
        composeProjectName: "owned-connector",
        controlUrl: `ws://127.0.0.1:${control.port}`,
        channels: [
          { name: "agent", kind: "agent", target: proxy.url.origin, healthPath: "/api/info" },
        ],
        processes: [],
      }),
    );
    connector = Bun.spawn([binary, "child", "--assignment", assignment, "--token-stdin"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    if (!connector.stdin || typeof connector.stdin === "number")
      throw new Error("Owned Connector token input required");
    connector.stdin.write(JSON.stringify({ token, environment: {} }));
    connector.stdin.end();
    await observe(
      async () => connections,
      (count) => count === 1,
    );
    return {
      hub,
      client: createOpenCodeClient((request, path) =>
        hub.request(attemptID, "agent", request, path),
      ),
      async delayRead(loss: Exclude<Loss, "none">) {
        const current = {
          entered: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        };
        heldRead = current;
        const generation = connections;
        const abort = new AbortController();
        return {
          ...current,
          client: createOpenCodeClient((request, path) =>
            hub.request(attemptID, "agent", new Request(request, { signal: abort.signal }), path),
          ),
          async detach() {
            await current.entered.promise;
            if (loss === "stream-close") abort.abort();
            else {
              child?.send("{");
              await observe(
                async () => connections,
                (count) => count > generation,
              );
            }
          },
          finish() {
            if (heldRead === current) heldRead = undefined;
            current.release.resolve();
          },
        };
      },
      async delay(loss: Loss, mutation: "prompt" | "session-create" = "prompt") {
        const current = {
          entered: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
          admitted: false,
          interrupted: Promise.withResolvers<boolean>(),
          mutation,
        };
        held = current;
        const generation = connections;
        const abort = new AbortController();
        const client = createOpenCodeClient((request, path) =>
          hub.request(attemptID, "agent", new Request(request, { signal: abort.signal }), path),
        );
        return {
          ...current,
          client,
          signal: abort.signal,
          async detach() {
            await current.entered.promise;
            if (loss === "stream-close") abort.abort();
            if (loss === "reconnect") {
              // A malformed control frame makes the actual Go read loop drop
              // and reconnect its socket while the admitted HTTP observation lives.
              child?.send("{");
              await observe(
                async () => connections,
                (count) => count > generation,
              );
            }
          },
        };
      },
      dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}
