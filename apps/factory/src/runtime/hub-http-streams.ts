import type { ServerWebSocket } from "bun";
import type { RuntimeChannelState } from "./hub-channels";
import { isCheckpointTraffic, runtimeResponseHeaders, scopeAppCookies } from "./hub-frames";
import { type ConnectorMessage, createControlledStream, type RuntimeSocketData } from "./hub-types";

export type HTTPStreamState =
  | {
      phase: "awaiting-headers";
      attemptID: string;
      connector: ServerWebSocket<RuntimeSocketData>;
      accessToken?: string;
      controller: ReadableStreamDefaultController<Uint8Array>;
      body: ReadableStream<Uint8Array>;
      head: boolean;
      keepsAwake: boolean;
      appPath?: string;
      originScopedCookies?: boolean;
      resolve(response: Response): void;
      reject(error: Error): void;
      timer: Timer;
      detach(): void;
    }
  | {
      phase: "streaming-body";
      attemptID: string;
      connector: ServerWebSocket<RuntimeSocketData>;
      accessToken?: string;
      controller: ReadableStreamDefaultController<Uint8Array>;
      head: boolean;
      keepsAwake: boolean;
      timer: Timer;
      detach(): void;
    };

type HTTPStreamEntry = { state: HTTPStreamState };

export class HTTPStreamManager {
  readonly #channels: RuntimeChannelState;
  readonly #pending = new Map<string, HTTPStreamEntry>();

  constructor(channels: RuntimeChannelState) {
    this.#channels = channels;
  }

  hasAttempt(attemptID: string) {
    for (const { state } of this.#pending.values()) if (state.attemptID === attemptID) return true;
    return false;
  }

  hasAwake(attemptID: string) {
    for (const { state } of this.#pending.values())
      if (state.attemptID === attemptID && state.keepsAwake) return true;
    return false;
  }

  async request(
    attemptID: string,
    channel: string,
    request: Request,
    path: string,
    requestHeaders: () => {
      headers: Record<string, string>;
      appAuthorization?: string;
      theiaConnectionToken?: string | undefined;
    },
    beforeSend?: (send: () => void) => Promise<void>,
    accessToken?: string,
    appCookies?: () => { appPath?: string; originScopedCookies?: boolean },
  ) {
    // The existing Workspace lock and Source writer epoch have already fenced
    // this internal checkpoint. An idle claim must block user traffic, not the
    // checkpoint RPCs needed to finish that same pause.
    const checkpointTraffic = isCheckpointTraffic(channel, request, path);
    if (this.#channels.idleClaims.has(attemptID) && !checkpointTraffic)
      return new Response("Runtime is stopping", { status: 503 });
    // Source is a concrete, Parent-only protocol over the canonical Actor
    // checkout. It is not a Project-declared App or arbitrary proxy target.
    const connections = channel === "source" ? this.#channels.parents : this.#channels.children;
    const child = connections.get(attemptID);
    if (!child) return new Response("Runtime is not ready", { status: 503 });
    if (channel === "source" && !this.#channels.sourceConnected(attemptID))
      return new Response("Native Source protocol is unavailable", { status: 503 });
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? Buffer.alloc(0)
        : Buffer.from(await request.arrayBuffer());
    if (body.length > (channel === "source" ? 4 << 20 : 1 << 20))
      return new Response("Request body is too large", { status: 413 });
    const streamID = crypto.randomUUID();
    if (request.signal.aborted) throw new Error("Runtime request was cancelled");
    const promise = new Promise<Response>((resolve, reject) => {
      const { stream: responseBody, controller } = createControlledStream<Uint8Array>(
        () => {
          const entry = this.#pending.get(streamID);
          if (entry) this.#release(streamID, entry);
          child.send(JSON.stringify({ type: "stream-close", streamId: streamID }));
        },
        { highWaterMark: 1 << 20, size: (chunk) => chunk?.byteLength ?? 0 },
      );
      const abort = () => {
        const entry = this.#pending.get(streamID);
        if (entry) this.#fail(streamID, entry, "Runtime request was cancelled");
      };
      request.signal.addEventListener("abort", abort, { once: true });
      const entry: HTTPStreamEntry = {
        state: {
          phase: "awaiting-headers",
          attemptID,
          connector: child,
          ...(accessToken ? { accessToken } : {}),
          controller,
          body: responseBody,
          head: request.method === "HEAD",
          keepsAwake:
            request.headers.get("sec-fetch-mode") === "navigate" ||
            !["GET", "HEAD", "OPTIONS"].includes(request.method),
          ...appCookies?.(),
          resolve,
          reject,
          timer: setTimeout(
            () => this.#fail(streamID, entry, "Runtime request timed out"),
            checkpointTraffic ? 120_000 : 60_000,
          ),
          detach: () => request.signal.removeEventListener("abort", abort),
        },
      };
      this.#pending.set(streamID, entry);
    });
    // Admission guards run after asynchronous body consumption, at the actual
    // frame-send boundary. They must not await the upstream response.
    const send = () => {
      if (this.#channels.idleClaims.has(attemptID) && !checkpointTraffic)
        throw new Error("Runtime is stopping");
      if (!this.#pending.has(streamID)) throw new Error("Runtime request is no longer pending");
      if (request.signal.aborted) throw new Error("Runtime request was cancelled");
      if (connections.get(attemptID) !== child)
        throw new Error("Runtime connection changed before dispatch");
      if (channel === "source" && !this.#channels.sourceConnected(attemptID))
        throw new Error("Native Source protocol is unavailable");
      if (
        child.send(
          JSON.stringify({
            type: "http-request",
            streamId: streamID,
            channel,
            method: request.method,
            path,
            ...requestHeaders(),
            data: body.toString("base64"),
          }),
        ) === 0
      )
        throw new Error("Connector send failed");
      if (
        request.headers.get("sec-fetch-mode") === "navigate" ||
        !["GET", "HEAD", "OPTIONS"].includes(request.method)
      )
        this.#channels.touch(attemptID);
    };
    const forward = async () => {
      if (beforeSend) await beforeSend(send);
      else send();
    };
    // Adopt the response immediately. Abort, suspend, or timeout can reject it
    // while admission is waiting for a SQL lock. A later guard cannot send a
    // frame after its consumer has already been failed.
    void forward().catch((cause: unknown) => {
      const entry = this.#pending.get(streamID);
      if (entry)
        this.#fail(
          streamID,
          entry,
          cause instanceof Error ? cause.message : "Connector send failed",
        );
    });
    return promise;
  }

  handleMessage(
    socket: ServerWebSocket<RuntimeSocketData>,
    streamID: string,
    message: ConnectorMessage,
  ): boolean {
    const entry = this.#pending.get(streamID);
    if (!entry) return false;
    if (socket.data.kind !== "connector") return true;
    const currentConnections =
      socket.data.role === "parent" ? this.#channels.parents : this.#channels.children;
    if (
      entry.state.connector !== socket ||
      entry.state.attemptID !== socket.data.attemptID ||
      currentConnections.get(socket.data.attemptID) !== socket
    )
      return true;
    if (message.type === "http-response") {
      const current = entry.state;
      if (current.phase !== "awaiting-headers") return true;
      try {
        const status = message.status ?? 502;
        const response = new Response(
          current.head || [204, 205, 304].includes(status) ? null : current.body,
          { status, headers: runtimeResponseHeaders(message) },
        );
        current.resolve(
          current.appPath
            ? scopeAppCookies(response, current.appPath, current.originScopedCookies)
            : response,
        );
        entry.state = {
          phase: "streaming-body",
          attemptID: current.attemptID,
          connector: current.connector,
          ...(current.accessToken ? { accessToken: current.accessToken } : {}),
          controller: current.controller,
          head: current.head,
          keepsAwake: current.keepsAwake,
          timer: current.timer,
          detach: current.detach,
        };
      } catch {
        this.#fail(streamID, entry, "Invalid runtime response");
      }
    } else if (message.type === "stream-data" && message.data) {
      const current = entry.state;
      const chunk = Buffer.from(message.data, "base64");
      if (
        current.phase !== "streaming-body" ||
        chunk.byteLength > 64 << 10 ||
        chunk.byteLength > (current.controller.desiredSize ?? 0)
      ) {
        this.#fail(streamID, entry, "Runtime response consumer is too slow");
        return true;
      }
      if (!current.head) current.controller.enqueue(chunk);
      clearTimeout(current.timer);
      current.timer = setTimeout(
        () => this.#fail(streamID, entry, "Runtime response timed out"),
        60_000,
      );
    } else if (message.type === "stream-end") {
      this.#finish(streamID, entry);
    } else if (message.type === "stream-error") {
      this.#fail(streamID, entry, message.error ?? "Runtime request failed");
    }
    return true;
  }

  revokeAccess(accessToken: string) {
    for (const [streamID, entry] of this.#pending) {
      if (entry.state.accessToken === accessToken)
        this.#fail(streamID, entry, "Runtime access revoked");
    }
  }

  failAttempt(attemptID: string, message: string, connector?: ServerWebSocket<RuntimeSocketData>) {
    for (const [streamID, entry] of this.#pending) {
      if (
        entry.state.attemptID === attemptID &&
        (!connector || entry.state.connector === connector)
      )
        this.#fail(streamID, entry, message);
    }
  }

  #finish(streamID: string, entry: HTTPStreamEntry) {
    if (entry.state.phase !== "streaming-body")
      return this.#fail(streamID, entry, "Runtime response has no headers");
    this.#release(streamID, entry);
    entry.state.controller.close();
  }

  #release(streamID: string, entry: HTTPStreamEntry) {
    clearTimeout(entry.state.timer);
    entry.state.detach();
    this.#pending.delete(streamID);
  }

  #fail(streamID: string, entry: HTTPStreamEntry, message: string) {
    this.#release(streamID, entry);
    const error = new Error(message);
    if (entry.state.phase === "streaming-body") entry.state.controller.error(error);
    else entry.state.reject(error);
    try {
      entry.state.connector.send(JSON.stringify({ type: "stream-close", streamId: streamID }));
    } catch {
      /* The request is already failed and released. */
    }
  }
}
