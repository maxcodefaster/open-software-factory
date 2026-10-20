import type { ServerWebSocket } from "bun";
import type { createDatabase } from "../../../../packages/db/src/client";
import { boundedSourceBody } from "../../../../packages/runtime-kubernetes/src/workspace-source";
import { json } from "../http";
import { scopeRuntimeEmbedding } from "../runtime/embedding";
import { scopeTheiaConnectionCookie, theiaConnectionToken } from "../runtime/hub";
import { createDeveloperIDEAccess, developerIDEPath } from "./developer-ide-access";
import { developerIDEOrigin } from "../developer-ide-origin";
import type { createDeveloperIDEController } from "./developer-ide-controller";
import type { createDeveloperIDERuntime } from "./developer-ide-runtime";
import type { createWorkspaceSourceController } from "./source-controller";
import { CommandError } from "../command-error";

export interface DeveloperEditorSocketData {
  readonly kind: "developer-editor";
  readonly token: string;
  readonly userID: string;
  readonly epoch: number;
  readonly backendURL: string;
  readonly connectionToken?: string;
}
type EditorSocket = ServerWebSocket<DeveloperEditorSocketData>;
// Bun supports handshake headers. DOM's constructor type omits that server-only overload.
const BackendWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};
interface Connection {
  readonly backend: WebSocket;
  readonly queue: Array<string | Uint8Array>;
  bytes: number;
  readonly deadline: ReturnType<typeof setTimeout>;
}
const editorRoute =
  /^\/editor\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/([1-9][0-9]*)(\/.*)$/;

function reconnectingEditorDocument() {
  // Only the initial, unsuccessful document retries its read. A working Theia
  // document never receives this timer, so dirty buffers are not reloaded.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="1"><title>Opening your editor</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:Canvas;color:CanvasText;font:16px/1.5 system-ui,sans-serif}p{max-width:36ch;padding:24px;text-align:center}</style></head><body><p role="status">Reconnecting to your editor…</p></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "retry-after": "1",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      },
    },
  );
}

export function createDeveloperIDEEdge(
  database: ReturnType<typeof createDatabase>,
  editors: ReturnType<typeof createDeveloperIDEController>,
  sources: ReturnType<typeof createWorkspaceSourceController>,
  factoryOrigin: string,
  runtime: ReturnType<typeof createDeveloperIDERuntime>,
) {
  const sockets = new Map<EditorSocket, Connection>();
  const requests = new Map<AbortController, string>();
  const access = createDeveloperIDEAccess(database, editors, factoryOrigin, (token) => {
    runtime.revokeEditor(token);
    for (const [socket] of sockets)
      if (socket.data.token === token) socket.close(1008, "Editor access revoked");
    for (const [controller, owner] of requests) if (owner === token) controller.abort();
  });
  function track(response: Response, controller: AbortController, finish: () => void) {
    if (!response.body) {
      finish();
      return response;
    }
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              target.close();
              finish();
            } else target.enqueue(chunk.value);
          } catch {
            target.error(new Error("Editor connection closed"));
            finish();
          }
        },
        async cancel() {
          controller.abort();
          await reader.cancel().catch(() => {});
          finish();
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }
  return {
    matches(path: string) {
      return editorRoute.test(path);
    },
    async issue(userID: string, sessionID: string, embedded: boolean, workspaceID?: string) {
      const current = await editors.get(userID);
      if (workspaceID) await sources.get(workspaceID, userID);
      const token = await access.issue({
        userID,
        sessionID,
        epoch: current.epoch,
        expires: Date.now() + 8 * 60 * 60 * 1000,
        embedded,
      });
      const url = new URL(
        developerIDEPath(userID, current.epoch),
        developerIDEOrigin(factoryOrigin, userID, current.epoch),
      );
      url.searchParams.set("factory-grant", token);
      if (workspaceID) {
        url.searchParams.set("workspace", workspaceID);
      }
      return url.href;
    },
    async socketData(request: Request): Promise<DeveloperEditorSocketData | Response> {
      const url = new URL(request.url);
      const matched = url.pathname.match(editorRoute);
      const userID = matched?.[1];
      const epoch = Number(matched?.[2]);
      const suffix = matched?.[3];
      if (
        !userID ||
        !suffix ||
        !Number.isSafeInteger(epoch) ||
        request.headers.get("origin") !== url.origin
      )
        return json({ error: "Editor origin is invalid" }, 403);
      const authorized = await access.authorize(request, userID, epoch);
      if (!authorized) return json({ error: "Editor access required" }, 401);
      // Pinned Theia multiplexes its RPC channels over native Socket.IO.
      if (suffix !== "/socket.io/") return json({ error: "Editor socket is unavailable" }, 404);
      const origin = await editors.connection(userID, epoch);
      const target = new URL(`${suffix}${url.search}`, origin);
      target.protocol = "ws:";
      const connectionToken = theiaConnectionToken(request.headers);
      return {
        kind: "developer-editor",
        token: authorized.token,
        userID,
        epoch,
        backendURL: target.href,
        ...(connectionToken ? { connectionToken } : {}),
      };
    },
    async executionSocketData(request: Request) {
      const url = new URL(request.url);
      const match = url.pathname.match(editorRoute);
      if (!match?.[1] || !match[3] || request.headers.get("origin") !== url.origin)
        return json({ error: "Editor origin is invalid" }, 403);
      const authorized = await access.authorize(request, match[1], Number(match[2]));
      if (!authorized) return json({ error: "Editor access required" }, 401);
      return (
        (await runtime.socketData(match[3], authorized)) ??
        json({ error: "Interactive path is invalid" }, 404)
      );
    },
    async route(request: Request) {
      const url = new URL(request.url);
      const matched = url.pathname.match(editorRoute);
      const userID = matched?.[1];
      const epoch = Number(matched?.[2]);
      const suffix = matched?.[3];
      if (!userID || !suffix || !Number.isSafeInteger(epoch))
        return json({ error: "Editor path is invalid" }, 404);
      const redeemed = await access.redeem(url, userID, epoch);
      if (redeemed) return redeemed;
      const authorized = await access.authorize(request, userID, epoch);
      if (!authorized) return json({ error: "Editor access required" }, 401);
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        request.headers.get("origin") !== url.origin
      )
        return json({ error: "Editor origin is invalid" }, 403);
      if (suffix === "/__factory/context" && request.method === "GET")
        return json({ factoryOrigin, userID, epoch });
      const presentation = suffix.match(
        /^\/__factory\/workspaces\/([0-9a-f-]{36})\/source\/context$/,
      );
      if (presentation?.[1]) {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        const source = await sources.get(presentation[1], userID);
        return json({ workspaceID: source.workspaceID, label: source.label });
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) controller.abort();
      requests.set(controller, authorized.token);
      const finish = () => {
        requests.delete(controller);
        request.signal.removeEventListener("abort", onAbort);
      };
      const initialDocument =
        request.method === "GET" &&
        suffix === "/" &&
        request.headers.get("accept")?.includes("text/html") === true;
      try {
        let response: Response;
        const execution = await runtime.route(
          suffix,
          new Request(request, { signal: controller.signal }),
          authorized,
        );
        const source = suffix.match(
          /^\/__factory\/workspaces\/([0-9a-f-]{36})\/source\/(stat|list|read|write|mkdir|rename|delete|search|events)$/,
        );
        if (execution) response = execution;
        else if (source?.[1] && source[2])
          response = await sources.forward(
            source[1],
            userID,
            source[2],
            new Request(request, { signal: controller.signal }),
          );
        else if (suffix.startsWith("/__factory/"))
          response = json({ error: "Editor operation is unavailable" }, 404);
        else {
          const origin = await editors.connection(userID, epoch);
          const headers = new Headers();
          for (const name of ["accept", "accept-language", "content-type", "if-none-match"]) {
            const value = request.headers.get(name);
            if (value) headers.set(name, value);
          }
          const token = theiaConnectionToken(request.headers);
          if (token) headers.set("cookie", `theia-connection-token=${token}`);
          const target = new URL(`${suffix}${url.search}`, origin);
          if (target.origin !== origin) {
            finish();
            return json({ error: "Editor path is invalid" }, 400);
          }
          const upstream = await fetch(target, {
            method: request.method,
            headers,
            ...(request.method !== "GET" && request.method !== "HEAD"
              ? { body: await boundedSourceBody(request, controller.signal) }
              : {}),
            signal: controller.signal,
            redirect: "manual",
          }).catch(() => {
            throw new CommandError("unavailable", "Editor connection is temporarily unavailable");
          });
          if (initialDocument && upstream.status === 503) {
            await upstream.body?.cancel();
            finish();
            return scopeRuntimeEmbedding(reconnectingEditorDocument(), factoryOrigin);
          }
          const outgoing = new Headers(upstream.headers);
          outgoing.delete("set-cookie");
          outgoing.delete("content-length");
          outgoing.delete("content-encoding");
          outgoing.set("cache-control", "no-store");
          const location = upstream.headers.get("location");
          if (location) {
            const redirected = new URL(location, target);
            if (redirected.origin !== origin)
              throw new Error("Editor attempted an external redirect");
            outgoing.set(
              "location",
              `${developerIDEPath(userID, epoch).slice(0, -1)}${redirected.pathname}${redirected.search}`,
            );
          }
          response = new Response(upstream.body, { status: upstream.status, headers: outgoing });
          const connectionCookie = upstream.headers
            .get("set-cookie")
            ?.match(/(?:^|,\s*)theia-connection-token=([A-Za-z0-9._~-]{1,256})(?:;|$)/);
          if (connectionCookie) {
            const scoped = scopeTheiaConnectionCookie(
              new Response(null, { headers: upstream.headers }),
              developerIDEPath(userID, epoch),
            ).headers.get("set-cookie");
            if (scoped) response.headers.set("set-cookie", scoped);
          }
        }
        return track(scopeRuntimeEmbedding(response, factoryOrigin), controller, finish);
      } catch (cause) {
        const aborted = controller.signal.aborted;
        finish();
        controller.abort();
        if (
          initialDocument &&
          !aborted &&
          cause instanceof CommandError &&
          cause.code === "unavailable"
        )
          return scopeRuntimeEmbedding(reconnectingEditorDocument(), factoryOrigin);
        throw cause;
      }
    },
    open(socket: EditorSocket) {
      if (!access.has(socket.data.token)) {
        socket.close(1008, "Editor access revoked");
        return;
      }
      const backend = new BackendWebSocket(socket.data.backendURL, {
        headers: socket.data.connectionToken
          ? { cookie: `theia-connection-token=${socket.data.connectionToken}` }
          : {},
      });
      backend.binaryType = "arraybuffer";
      const connection: Connection = {
        backend,
        queue: [],
        bytes: 0,
        deadline: setTimeout(() => socket.close(1011, "Editor connection timed out"), 10_000),
      };
      sockets.set(socket, connection);
      backend.addEventListener("open", () => {
        clearTimeout(connection.deadline);
        for (const item of connection.queue)
          backend.send(typeof item === "string" ? item : new Uint8Array(item));
        connection.queue.length = 0;
        connection.bytes = 0;
      });
      backend.addEventListener("message", (event) => {
        if (socket.getBufferedAmount() > 12 << 20) {
          socket.close(1009, "Editor output limit exceeded");
          return;
        }
        if (typeof event.data === "string") socket.send(event.data);
        else socket.send(new Uint8Array(event.data as ArrayBuffer));
      });
      backend.addEventListener("close", () => {
        if (sockets.has(socket)) socket.close(1011, "Editor backend disconnected");
      });
      backend.addEventListener("error", () => {
        if (sockets.has(socket)) socket.close(1011, "Editor backend unavailable");
      });
    },
    message(socket: EditorSocket, message: string | Uint8Array) {
      const connection = sockets.get(socket);
      if (!connection) return;
      if (!access.has(socket.data.token)) {
        socket.close(1008, "Editor access revoked");
        return;
      }
      const bytes = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
      if (
        connection.backend.bufferedAmount + connection.bytes + bytes > 12 << 20 ||
        connection.queue.length >= 64
      ) {
        socket.close(1009, "Editor input limit exceeded");
        return;
      }
      if (connection.backend.readyState === WebSocket.OPEN)
        connection.backend.send(typeof message === "string" ? message : new Uint8Array(message));
      else if (connection.backend.readyState === WebSocket.CONNECTING) {
        connection.queue.push(typeof message === "string" ? message : message.slice());
        connection.bytes += bytes;
      }
    },
    close(socket: EditorSocket) {
      const connection = sockets.get(socket);
      if (!connection) return;
      sockets.delete(socket);
      clearTimeout(connection.deadline);
      connection.backend.close();
    },
    revokeUser: access.revokeUser,
    async sweep(userID?: string) {
      await access.sweep(userID);
      runtime.sweep();
    },
  };
}
