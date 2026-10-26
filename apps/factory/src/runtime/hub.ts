import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { RuntimeProcessEvents } from "./process-events";
import { factoryRequestURL } from "../request-origin";

const protocol = "factory-runtime-connector-v1";

export type RuntimeSocketData =
  | {
      readonly kind: "connector";
      readonly role: "parent" | "child";
      readonly attemptID: string;
      readonly generation: number;
    }
  | {
      readonly kind: "browser";
      readonly attemptID: string;
      readonly channel: string;
      readonly path: string;
      readonly theiaConnectionToken?: string;
      readonly accessToken?: string;
      readonly headers?: Record<string, string>;
      readonly protocol?: string;
    };

type ConnectorMessage = {
  type: string;
  role?: string;
  phase?: string;
  process?: string;
  processLabel?: string;
  processState?: string;
  startedAt?: string;
  exitCode?: number;
  terminalId?: string;
  terminalCount?: number;
  terminalBusy?: number;
  terminalRevision?: number;
  channels?: Array<{ name?: string; kind?: string }>;
  error?: string;
  streamId?: string;
  status?: number;
  headers?: Record<string, string>;
  data?: string;
  messageType?: number;
  protocol?: string;
  theiaConnectionToken?: string;
  operationId?: string;
  action?: string;
  commitSha?: string;
  remoteSha?: string;
};

export type RuntimeProcessSnapshot = {
  name: string;
  label?: string;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  output: string;
  startedAt?: string;
  exitCode?: number;
};

type ParentOperationResult = { commitSHA?: string; remoteSHA?: string; data?: string };

export class RuntimeParentOperationError extends Error {
  constructor(
    readonly action: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeParentOperationError";
  }
}

type PendingHTTP = {
  attemptID: string;
  accessToken?: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  body: ReadableStream<Uint8Array>;
  responded: boolean;
  head: boolean;
  keepsAwake: boolean;
  appPath?: string;
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: Timer;
  detach(): void;
};

type BrowserStream = {
  socket: ServerWebSocket<RuntimeSocketData>;
  connector: ServerWebSocket<RuntimeSocketData>;
  ready: boolean;
  pending: Array<{ messageType: 1 | 2; data: string }>;
};

type ConnectorAuthority = {
  parentHash: string;
  childHash: string;
  generation: number;
};

type StatusObservation = {
  authority: ConnectorAuthority | undefined;
  terminal: boolean;
  timer?: Timer;
};

export class RuntimeHub {
  readonly #terminalSockets = new WeakSet<ServerWebSocket<RuntimeSocketData>>();
  readonly #parents = new Map<string, ServerWebSocket<RuntimeSocketData>>();
  readonly #children = new Map<string, ServerWebSocket<RuntimeSocketData>>();
  readonly #browsers = new Map<string, BrowserStream>();
  readonly #browserStreams = new Map<ServerWebSocket<RuntimeSocketData>, string>();
  readonly #pendingHTTP = new Map<string, PendingHTTP>();
  readonly #pendingOperations = new Map<
    string,
    {
      attemptID: string;
      action: string;
      fingerprint: string;
      promise: Promise<ParentOperationResult>;
      resolve(value: ParentOperationResult): void;
      reject(error: Error): void;
      timer: Timer;
    }
  >();
  readonly #pendingChildOperations = new Map<
    string,
    {
      attemptID: string;
      resolve(): void;
      reject(error: Error): void;
      timer: Timer;
    }
  >();
  readonly #tokens = new Map<string, ConnectorAuthority>();
  readonly #disconnectTimers = new Map<string, Timer>();
  readonly #statusObservations = new Map<string, StatusObservation>();
  readonly #processes = new Map<string, Map<string, RuntimeProcessSnapshot>>();
  readonly processEvents = new RuntimeProcessEvents((attemptID) => this.processes(attemptID));
  readonly #appChannels = new Map<string, Set<string>>();
  readonly #onStatus: (attemptID: string, phase: string, error?: string) => Promise<void>;
  readonly #activity = new Map<
    string,
    {
      lastUse: number;
      terminals: number | null;
      busyTerminals: number | null;
      terminalObservedAt: number;
      revision: number;
    }
  >();
  readonly #idleClaims = new Set<string>();

  constructor(
    onStatus: (attemptID: string, phase: string, error?: string) => Promise<void>,
    private readonly now = Date.now,
  ) {
    this.#onStatus = onStatus;
  }

  #observeStatus(producer: ServerWebSocket<RuntimeSocketData>, phase: string, error?: string) {
    if (producer.data.kind !== "connector") return;
    const { attemptID, role } = producer.data;
    const authority = this.#tokens.get(attemptID);
    const key = `${attemptID}:${role}`;
    const terminal = ["stopped", "failed", "cleanup-failed"].includes(phase);
    const previous = this.#statusObservations.get(key);
    if (previous && previous.authority === authority && previous.terminal && !terminal) return;
    if (previous?.timer) clearTimeout(previous.timer);
    const observation: StatusObservation = { authority, terminal };
    this.#statusObservations.set(key, observation);
    const forget = () => {
      if (this.#statusObservations.get(key) !== observation) return;
      if (observation.timer) clearTimeout(observation.timer);
      this.#statusObservations.delete(key);
    };
    const relevant = () => {
      if (
        !authority ||
        this.#tokens.get(attemptID) !== authority ||
        this.#statusObservations.get(key) !== observation
      )
        return false;
      if (terminal) return true;
      const current = role === "parent" ? this.#parents : this.#children;
      return phase === "reconnecting" || phase === "disconnected"
        ? !current.has(attemptID)
        : current.get(attemptID) === producer;
    };
    const unavailable = () => {
      // Status is observation, not authority to replay a create or inference.
      // Never let its rejected database work escape a WebSocket callback.
      if (!relevant()) {
        forget();
        return;
      }
      console.error("Runtime status observation is unavailable; recorded intent was retained");
      // Keep healthy compute connected. A fresh observation supersedes this
      // retry, and revocation cancels it. Terminal facts survive producer close.
      observation.timer = setTimeout(() => {
        delete observation.timer;
        if (!relevant()) {
          forget();
          return;
        }
        deliver();
      }, 1_000);
      observation.timer.unref();
    };
    const deliver = () => {
      try {
        void this.#onStatus(attemptID, phase, error).then(forget, unavailable);
      } catch {
        unavailable();
      }
    };
    deliver();
  }

  allow(attemptID: string, generation: number, parentHash: string, childHash: string) {
    this.#tokens.set(attemptID, { parentHash, childHash, generation });
  }

  authorize(request: Request, hashToken: (token: string) => string): RuntimeSocketData | null {
    const authorization = request.headers.get("authorization");
    const role = request.headers.get("x-factory-connector-role");
    const attemptID = request.headers.get("x-factory-runtime-attempt");
    const generation = Number(request.headers.get("x-factory-runtime-generation"));
    if (
      !authorization?.startsWith("Bearer ") ||
      (role !== "parent" && role !== "child") ||
      !attemptID ||
      !Number.isSafeInteger(generation)
    )
      return null;
    const expected = this.#tokens.get(attemptID);
    if (
      !expected ||
      expected.generation !== generation ||
      (role === "parent" ? expected.parentHash : expected.childHash) !==
        hashToken(authorization.slice(7))
    )
      return null;
    return { kind: "connector", role, attemptID, generation };
  }

  open(socket: ServerWebSocket<RuntimeSocketData>) {
    if (socket.data.kind === "browser") {
      if (this.#idleClaims.has(socket.data.attemptID))
        return socket.close(1013, "Runtime is stopping");
      const child = this.#children.get(socket.data.attemptID);
      if (!child) return socket.close(1013, "Runtime is not ready");
      const streamID = crypto.randomUUID();
      this.#browsers.set(streamID, { socket, connector: child, ready: false, pending: [] });
      this.#browserStreams.set(socket, streamID);
      if (socket.data.channel === "terminal") this.#touch(socket.data.attemptID);
      child.send(
        JSON.stringify({
          type: "websocket-open",
          streamId: streamID,
          channel: socket.data.channel,
          path: socket.data.path,
          ...(socket.data.headers ? { headers: socket.data.headers } : {}),
          ...(socket.data.protocol ? { protocol: socket.data.protocol } : {}),
          ...(socket.data.theiaConnectionToken
            ? { theiaConnectionToken: socket.data.theiaConnectionToken }
            : {}),
        }),
      );
      return;
    }
    const connections = socket.data.role === "parent" ? this.#parents : this.#children;
    if (connections.has(socket.data.attemptID)) {
      socket.close(1008, "Connector role is already connected");
      return;
    }
    connections.set(socket.data.attemptID, socket);
    this.#touch(socket.data.attemptID);
  }

  message(socket: ServerWebSocket<RuntimeSocketData>, raw: string | Buffer) {
    if (socket.data.kind === "browser") {
      // Only terminal input is human activity. Language traffic, App polling
      // and live-reload keepalives must not keep an unattended Workspace awake.
      if (socket.data.channel === "terminal" && Buffer.isBuffer(raw))
        this.#touch(socket.data.attemptID);
      const streamID = this.#browserStreams.get(socket);
      const child = this.#children.get(socket.data.attemptID);
      const stream = streamID ? this.#browsers.get(streamID) : undefined;
      if (streamID && child && stream) {
        const frame = {
          messageType: (typeof raw === "string" ? 1 : 2) as 1 | 2,
          data: Buffer.from(raw).toString("base64"),
        };
        if (stream.ready) {
          child.send(JSON.stringify({ type: "websocket-message", streamId: streamID, ...frame }));
        } else if (stream.pending.length < 16) {
          stream.pending.push(frame);
        } else {
          stream.socket.close(1009, "Too many frames before channel readiness");
        }
      }
      return;
    }
    const current = socket.data.role === "parent" ? this.#parents : this.#children;
    if (current.get(socket.data.attemptID) !== socket) return;
    const message = JSON.parse(String(raw)) as ConnectorMessage;
    if (
      message.type === "status" &&
      ["stopped", "failed", "cleanup-failed"].includes(message.phase ?? "")
    )
      this.#terminalSockets.add(socket);
    if (socket.data.role === "child" && message.type === "hello" && message.role === "child") {
      const activity = this.#activity.get(socket.data.attemptID);
      if (activity) {
        activity.terminals = null;
        activity.busyTerminals = null;
        activity.revision = -1;
      }
      this.#observeTerminals(socket.data.attemptID, message);
      const timer = this.#disconnectTimers.get(`${socket.data.attemptID}:child`);
      if (timer) clearTimeout(timer);
      this.#disconnectTimers.delete(`${socket.data.attemptID}:child`);
      this.#processes.delete(socket.data.attemptID);
      this.processEvents.changed(socket.data.attemptID);
      this.#appChannels.set(
        socket.data.attemptID,
        new Set(
          (message.channels ?? [])
            .filter((channel) => channel.kind === "app" && isAppProcessName(channel.name))
            .map((channel) => channel.name as string),
        ),
      );
      if (this.#parents.has(socket.data.attemptID)) {
        this.#observeStatus(socket, "ready");
      }
      return;
    }
    if (socket.data.role === "child" && message.type === "terminal-state") {
      this.#observeTerminals(socket.data.attemptID, message);
      return;
    }
    if (socket.data.role === "child" && message.type === "status" && message.phase) {
      this.#observeStatus(socket, message.phase, message.error);
      return;
    }
    if (
      socket.data.role === "child" &&
      message.type === "process-state" &&
      message.process?.match(/^app(?:-[a-z][a-z0-9-]{0,26})?$/) &&
      (message.processState === "starting" ||
        message.processState === "running" ||
        message.processState === "stopping" ||
        message.processState === "stopped" ||
        message.processState === "failed")
    ) {
      const process = this.#process(socket.data.attemptID, message.process);
      process.state = message.processState;
      if (message.processLabel?.trim() && message.processLabel.length <= 64) {
        process.label = message.processLabel;
      }
      if (message.startedAt && !Number.isNaN(Date.parse(message.startedAt))) {
        process.startedAt = message.startedAt;
      } else {
        delete process.startedAt;
      }
      if (typeof message.exitCode === "number" && Number.isSafeInteger(message.exitCode)) {
        process.exitCode = message.exitCode;
      } else delete process.exitCode;
      this.processEvents.changed(socket.data.attemptID);
      return;
    }
    if (
      socket.data.role === "child" &&
      message.type === "process-output" &&
      message.process?.match(/^app(?:-[a-z][a-z0-9-]{0,26})?$/) &&
      message.data &&
      message.data.length <= 48 << 10
    ) {
      const process = this.#process(socket.data.attemptID, message.process);
      const output = Buffer.from(message.data, "base64").toString("utf8");
      process.output = `${process.output}${output}`.slice(-(32 << 10));
      this.processEvents.changed(socket.data.attemptID);
      return;
    }
    if (socket.data.role === "parent" && message.type === "status" && message.phase) {
      const timer = this.#disconnectTimers.get(`${socket.data.attemptID}:parent`);
      if (timer) clearTimeout(timer);
      this.#disconnectTimers.delete(`${socket.data.attemptID}:parent`);
      this.#observeStatus(socket, message.phase, message.error);
      return;
    }
    if (socket.data.role === "parent" && message.type === "hello" && message.role === "parent") {
      const timer = this.#disconnectTimers.get(`${socket.data.attemptID}:parent`);
      if (timer) clearTimeout(timer);
      this.#disconnectTimers.delete(`${socket.data.attemptID}:parent`);
      if (this.#children.has(socket.data.attemptID)) {
        this.#observeStatus(socket, "ready");
      }
      return;
    }
    if (
      socket.data.role === "child" &&
      message.type === "operation-response" &&
      message.operationId
    ) {
      const pending = this.#pendingChildOperations.get(message.operationId);
      if (!pending || pending.attemptID !== socket.data.attemptID) return;
      clearTimeout(pending.timer);
      this.#pendingChildOperations.delete(message.operationId);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve();
      return;
    }
    if (
      socket.data.role === "parent" &&
      message.type === "operation-response" &&
      message.operationId
    ) {
      const pending = this.#pendingOperations.get(message.operationId);
      if (
        !pending ||
        pending.attemptID !== socket.data.attemptID ||
        this.#parents.get(pending.attemptID) !== socket ||
        pending.action !== message.action
      )
        return;
      clearTimeout(pending.timer);
      this.#pendingOperations.delete(message.operationId);
      if (message.error)
        pending.reject(new RuntimeParentOperationError(pending.action, message.error));
      else
        pending.resolve({
          ...(message.commitSha ? { commitSHA: message.commitSha } : {}),
          ...(message.remoteSha ? { remoteSHA: message.remoteSha } : {}),
          ...(message.data !== undefined ? { data: message.data } : {}),
        });
      return;
    }
    if (!message.streamId) return;
    const pending = this.#pendingHTTP.get(message.streamId);
    if (pending) {
      if (socket.data.role !== "child" || pending.attemptID !== socket.data.attemptID) return;
      if (message.type === "http-response") {
        if (pending.responded) return;
        try {
          const status = message.status ?? 502;
          const response = new Response(
            pending.head || [204, 205, 304].includes(status) ? null : pending.body,
            {
              status,
              ...(message.headers ? { headers: message.headers } : {}),
            },
          );
          pending.resolve(pending.appPath ? scopeAppCookies(response, pending.appPath) : response);
          pending.responded = true;
        } catch {
          this.#failHTTP(message.streamId, pending, "Invalid runtime response");
        }
      } else if (message.type === "stream-data" && message.data) {
        const chunk = Buffer.from(message.data, "base64");
        if (
          !pending.responded ||
          chunk.byteLength > 64 << 10 ||
          chunk.byteLength > (pending.controller.desiredSize ?? 0)
        ) {
          this.#failHTTP(message.streamId, pending, "Runtime response consumer is too slow");
          return;
        }
        if (!pending.head) pending.controller.enqueue(chunk);
        clearTimeout(pending.timer);
        pending.timer = setTimeout(
          () => this.#failHTTP(message.streamId as string, pending, "Runtime response timed out"),
          60_000,
        );
      } else if (message.type === "stream-end") this.#finishHTTP(message.streamId, pending);
      else if (message.type === "stream-error")
        this.#failHTTP(message.streamId, pending, message.error ?? "Runtime request failed");
      return;
    }
    const browser = this.#browsers.get(message.streamId);
    if (
      !browser ||
      socket.data.role !== "child" ||
      browser.socket.data.attemptID !== socket.data.attemptID ||
      browser.connector !== socket ||
      this.#children.get(socket.data.attemptID) !== socket
    )
      return;
    if (message.type === "websocket-ready") {
      if (browser.ready) return;
      browser.ready = true;
      if (browser.socket.data.kind === "browser" && browser.socket.data.channel === "terminal") {
        browser.socket.send(JSON.stringify({ type: "terminal-ready" }));
      }
      for (const frame of browser.pending) {
        socket.send(
          JSON.stringify({ type: "websocket-message", streamId: message.streamId, ...frame }),
        );
      }
      browser.pending = [];
    } else if (message.type === "websocket-message" && message.data) {
      const data = Buffer.from(message.data, "base64");
      browser.socket.send(message.messageType === 1 ? data.toString() : data);
    } else if (message.type === "stream-close" || message.type === "stream-error") {
      browser.socket.close(message.type === "stream-error" ? 1011 : 1000, message.error);
    }
  }

  close(socket: ServerWebSocket<RuntimeSocketData>) {
    if (socket.data.kind === "browser") {
      const streamID = this.#browserStreams.get(socket);
      if (streamID) {
        this.#children
          .get(socket.data.attemptID)
          ?.send(JSON.stringify({ type: "stream-close", streamId: streamID }));
        this.#browsers.delete(streamID);
      }
      this.#browserStreams.delete(socket);
      return;
    }
    const connections = socket.data.role === "parent" ? this.#parents : this.#children;
    if (connections.get(socket.data.attemptID) === socket) {
      const role = socket.data.role;
      const attemptID = socket.data.attemptID;
      connections.delete(socket.data.attemptID);
      this.#failAttemptStreams(attemptID, "Runtime channel disconnected");
      if (this.#terminalSockets.has(socket)) return;
      this.#observeStatus(socket, "reconnecting", `${role} connector reconnecting`);
      const timerKey = `${attemptID}:${role}`;
      const previous = this.#disconnectTimers.get(timerKey);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.#disconnectTimers.delete(timerKey);
        const reconnected =
          role === "child" ? this.#children.has(attemptID) : this.#parents.has(attemptID);
        if (!reconnected) {
          this.#observeStatus(socket, "disconnected", `${role} connector did not reconnect`);
        }
      }, 15_000);
      this.#disconnectTimers.set(timerKey, timer);
    }
  }

  async request(
    attemptID: string,
    channel: string,
    request: Request,
    path: string,
    beforeSend?: (send: () => void) => Promise<void>,
    accessToken?: string,
  ) {
    if (this.#idleClaims.has(attemptID))
      return new Response("Runtime is stopping", { status: 503 });
    const child = this.#children.get(attemptID);
    if (!child) return new Response("Runtime is not ready", { status: 503 });
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? Buffer.alloc(0)
        : Buffer.from(await request.arrayBuffer());
    if (body.length > 1 << 20) return new Response("Request body is too large", { status: 413 });
    const streamID = crypto.randomUUID();
    if (request.signal.aborted) throw new Error("Runtime request was cancelled");
    const promise = new Promise<Response>((resolve, reject) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          cancel: () => {
            const pending = this.#pendingHTTP.get(streamID);
            if (pending) this.#releaseHTTP(streamID, pending);
            child.send(JSON.stringify({ type: "stream-close", streamId: streamID }));
          },
        },
        { highWaterMark: 1 << 20, size: (chunk) => chunk?.byteLength ?? 0 },
      );
      const abort = () => {
        const pending = this.#pendingHTTP.get(streamID);
        if (pending) this.#failHTTP(streamID, pending, "Runtime request was cancelled");
      };
      request.signal.addEventListener("abort", abort, { once: true });
      const pending: PendingHTTP = {
        attemptID,
        ...(accessToken ? { accessToken } : {}),
        controller,
        body,
        responded: false,
        head: request.method === "HEAD",
        keepsAwake:
          request.headers.get("sec-fetch-mode") === "navigate" ||
          !["GET", "HEAD", "OPTIONS"].includes(request.method),
        ...(this.hasAppChannel(attemptID, channel) &&
        new URL(request.url).pathname.startsWith("/runtime/")
          ? {
              appPath: new URL(request.url).pathname.slice(
                0,
                new URL(request.url).pathname.length - new URL(path, request.url).pathname.length,
              ),
            }
          : {}),
        resolve,
        reject,
        timer: setTimeout(
          () => this.#failHTTP(streamID, pending, "Runtime request timed out"),
          60_000,
        ),
        detach: () => request.signal.removeEventListener("abort", abort),
      };
      this.#pendingHTTP.set(streamID, pending);
    });
    // Admission guards run after asynchronous body consumption, at the actual
    // frame-send boundary. They must not await the upstream response.
    const send = () => {
      if (this.#idleClaims.has(attemptID)) throw new Error("Runtime is stopping");
      if (!this.#pendingHTTP.has(streamID)) throw new Error("Runtime request is no longer pending");
      if (request.signal.aborted) throw new Error("Runtime request was cancelled");
      if (this.#children.get(attemptID) !== child)
        throw new Error("Runtime connection changed before dispatch");
      if (
        child.send(
          JSON.stringify({
            type: "http-request",
            streamId: streamID,
            channel,
            method: request.method,
            path,
            headers: this.hasAppChannel(attemptID, channel)
              ? appRuntimeHeaders(request, path)
              : safeRuntimeHeaders(request.headers),
            ...(channel === "ide"
              ? { theiaConnectionToken: theiaConnectionToken(request.headers) }
              : {}),
            data: body.toString("base64"),
          }),
        ) <= 0
      )
        throw new Error("Connector send failed");
      if (
        request.headers.get("sec-fetch-mode") === "navigate" ||
        !["GET", "HEAD", "OPTIONS"].includes(request.method)
      )
        this.#touch(attemptID);
    };
    const forward = async () => {
      if (beforeSend) await beforeSend(send);
      else send();
    };
    // Adopt the response immediately. Abort, suspend, or timeout can reject it
    // while admission is waiting for a SQL lock. A later guard cannot send a
    // frame after its consumer has already been failed.
    void forward().catch((cause: unknown) => {
      const pending = this.#pendingHTTP.get(streamID);
      if (pending)
        this.#failHTTP(
          streamID,
          pending,
          cause instanceof Error ? cause.message : "Connector send failed",
        );
    });
    return promise;
  }

  async parentOperation(
    attemptID: string,
    operation: Record<string, string | number> & { operationId: string; action: string },
    beforeSend?: (send: () => void) => Promise<void>,
  ): Promise<ParentOperationResult> {
    if (this.#idleClaims.has(attemptID)) throw new Error("Runtime is stopping");
    const parent = this.#parents.get(attemptID);
    if (!parent) throw new Error("Runtime parent is not ready");
    const operationID = operation["operationId"];
    if (!operationID) throw new Error("Operation identity is required");
    const payload = { ...operation };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)),
        ),
      )
      .digest("hex");
    const existing = this.#pendingOperations.get(operationID);
    if (existing) {
      if (existing.attemptID !== attemptID || existing.fingerprint !== fingerprint)
        throw new Error("Runtime parent operation identity has conflicting input");
      return existing.promise;
    }
    const { promise, resolve, reject } = Promise.withResolvers<ParentOperationResult>();
    const timer = setTimeout(
      () => {
        if (this.#pendingOperations.get(operationID) !== target) return;
        this.#pendingOperations.delete(operationID);
        reject(new Error("Runtime parent operation timed out"));
      },
      operation.action === "browser-renew" ? 5_000 : 60_000,
    );
    const target = {
      attemptID,
      action: payload["action"] ?? "",
      fingerprint,
      promise,
      resolve,
      reject,
      timer,
    };
    this.#pendingOperations.set(operationID, target);
    const send = () => {
      if (this.#idleClaims.has(attemptID)) throw new Error("Runtime is stopping");
      if (!target || this.#pendingOperations.get(operationID) !== target)
        throw new Error("Runtime parent operation is no longer pending");
      if (this.#parents.get(attemptID) !== parent)
        throw new Error("Runtime parent connection changed before dispatch");
      if (parent.send(JSON.stringify({ ...payload, type: "operation-request" })) <= 0)
        throw new Error("Runtime parent operation could not be sent");
      this.#touch(attemptID);
    };
    const forward = async () => {
      if (beforeSend) await beforeSend(send);
      else send();
    };
    void forward().catch((cause: unknown) => {
      if (!target || this.#pendingOperations.get(operationID) !== target) return;
      clearTimeout(target.timer);
      this.#pendingOperations.delete(operationID);
      target.reject(cause instanceof Error ? cause : new Error("Runtime parent send failed"));
    });
    return promise;
  }

  async childOperation(attemptID: string, operation: Record<string, string>): Promise<void> {
    if (this.#idleClaims.has(attemptID)) throw new Error("Runtime is stopping");
    const child = this.#children.get(attemptID);
    if (!child) throw new Error("Runtime child is not ready");
    const operationID = operation["operationId"];
    if (!operationID) throw new Error("Operation identity is required");
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingChildOperations.delete(operationID);
        reject(new Error("Runtime child operation timed out"));
      }, 20_000);
      this.#pendingChildOperations.set(operationID, { attemptID, resolve, reject, timer });
    });
    this.#touch(attemptID);
    if (child.send(JSON.stringify({ type: "operation-request", ...operation })) <= 0) {
      const pending = this.#pendingChildOperations.get(operationID);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingChildOperations.delete(operationID);
      }
      throw new Error("Runtime child operation could not be sent");
    }
    return promise;
  }

  stop(attemptID: string) {
    this.#tokens.delete(attemptID);
    const parent = this.#parents.get(attemptID);
    if (!parent) return false;
    const sent = parent.send(JSON.stringify({ type: "stop" }));
    if (sent <= 0) return false;
    return true;
  }

  suspend(attemptID: string) {
    this.#failAttemptStreams(attemptID, "Runtime is stopping");
  }

  revokeAccess(accessToken: string) {
    this.processEvents.revokeAccess(accessToken);
    for (const [streamID, browser] of this.#browsers) {
      if (
        browser.socket.data.kind === "browser" &&
        browser.socket.data.accessToken === accessToken
      ) {
        browser.socket.close(1008, "Runtime access revoked");
        this.close(browser.socket);
        this.#browsers.delete(streamID);
      }
    }
    for (const [streamID, pending] of this.#pendingHTTP) {
      if (pending.accessToken === accessToken)
        this.#failHTTP(streamID, pending, "Runtime access revoked");
    }
  }

  revoke(attemptID: string) {
    this.#activity.delete(attemptID);
    this.#idleClaims.delete(attemptID);
    this.#tokens.delete(attemptID);
    for (const role of ["parent", "child"]) {
      const key = `${attemptID}:${role}`;
      const observation = this.#statusObservations.get(key);
      if (observation?.timer) clearTimeout(observation.timer);
      this.#statusObservations.delete(key);
      const disconnected = this.#disconnectTimers.get(key);
      if (disconnected) clearTimeout(disconnected);
      this.#disconnectTimers.delete(key);
    }
    const parent = this.#parents.get(attemptID);
    const child = this.#children.get(attemptID);
    this.#parents.delete(attemptID);
    this.#children.delete(attemptID);
    this.#processes.delete(attemptID);
    this.#appChannels.delete(attemptID);
    parent?.close(1000, "Runtime stopped");
    child?.close(1000, "Runtime stopped");
    this.#failAttemptStreams(attemptID, "Runtime stopped");
  }

  connected(attemptID: string) {
    return this.#parents.has(attemptID) && this.#children.has(attemptID);
  }
  parentConnected(attemptID: string) {
    return this.#parents.has(attemptID);
  }

  use(attemptID: string) {
    if (!this.connected(attemptID) || this.#idleClaims.has(attemptID)) return false;
    this.#touch(attemptID);
    return true;
  }

  claimIdle(attemptID: string, idleMS: number) {
    const activity = this.#activity.get(attemptID);
    if (
      // Native PTY Resume currently fails to reopen /dev/tty. Do not admit
      // automatic Pause of an open terminal, including a detached idle shell.
      activity?.terminals !== 0 ||
      activity?.busyTerminals !== 0 ||
      this.now() - activity.terminalObservedAt > 15_000 ||
      this.now() - activity.lastUse < idleMS ||
      !this.connected(attemptID) ||
      this.#idleClaims.has(attemptID) ||
      [...this.#pendingHTTP.values()].some(
        (operation) => operation.attemptID === attemptID && operation.keepsAwake,
      ) ||
      [...this.#pendingOperations.values(), ...this.#pendingChildOperations.values()].some(
        (operation) => operation.attemptID === attemptID,
      )
    )
      return false;
    this.#idleClaims.add(attemptID);
    return true;
  }
  releaseIdle(attemptID: string) {
    this.#idleClaims.delete(attemptID);
    this.#touch(attemptID);
  }
  #touch(attemptID: string) {
    const activity = this.#activity.get(attemptID);
    if (activity) activity.lastUse = this.now();
    else
      this.#activity.set(attemptID, {
        lastUse: this.now(),
        terminals: null,
        busyTerminals: null,
        terminalObservedAt: this.now(),
        revision: -1,
      });
  }
  #observeTerminals(attemptID: string, message: ConnectorMessage) {
    const { terminalCount, terminalBusy, terminalRevision } = message;
    const activity = this.#activity.get(attemptID);
    if (!activity) return;
    if (
      terminalCount === undefined ||
      terminalRevision === undefined ||
      !Number.isSafeInteger(terminalCount) ||
      terminalCount < 0 ||
      terminalCount > 8 ||
      terminalBusy === undefined ||
      !Number.isSafeInteger(terminalBusy) ||
      terminalBusy < 0 ||
      terminalBusy > terminalCount ||
      !Number.isSafeInteger(terminalRevision) ||
      terminalRevision < 0
    ) {
      activity.terminals = null;
      activity.busyTerminals = null;
      return;
    }
    if (terminalRevision < activity.revision) return;
    if (terminalRevision === activity.revision) {
      if (activity.terminals !== terminalCount || activity.busyTerminals !== terminalBusy) {
        activity.busyTerminals = null;
        return;
      }
      activity.terminalObservedAt = this.now();
      return;
    }
    activity.terminals = terminalCount;
    activity.busyTerminals = terminalBusy;
    activity.terminalObservedAt = this.now();
    activity.revision = terminalRevision;
    activity.lastUse = this.now();
  }

  processes(attemptID: string): RuntimeProcessSnapshot[] {
    return [...(this.#processes.get(attemptID)?.values() ?? [])].map((process) => ({
      ...process,
    }));
  }

  hasAppChannel(attemptID: string, channel: string) {
    return this.#appChannels.get(attemptID)?.has(channel) === true;
  }

  appChannels(attemptID: string) {
    return [...(this.#appChannels.get(attemptID) ?? [])];
  }

  static protocol() {
    return protocol;
  }

  #finishHTTP(streamID: string, pending: PendingHTTP) {
    if (!pending.responded)
      return this.#failHTTP(streamID, pending, "Runtime response has no headers");
    this.#releaseHTTP(streamID, pending);
    pending.controller.close();
  }

  #releaseHTTP(streamID: string, pending: PendingHTTP) {
    clearTimeout(pending.timer);
    pending.detach();
    this.#pendingHTTP.delete(streamID);
  }

  #process(attemptID: string, name: string) {
    let processes = this.#processes.get(attemptID);
    if (!processes) {
      processes = new Map();
      this.#processes.set(attemptID, processes);
    }
    let process = processes.get(name);
    if (!process) {
      process = { name, state: "starting", output: "" };
      processes.set(name, process);
    }
    return process;
  }

  #failHTTP(streamID: string, pending: PendingHTTP, message: string) {
    this.#releaseHTTP(streamID, pending);
    const error = new Error(message);
    if (pending.responded) pending.controller.error(error);
    else pending.reject(error);
    try {
      this.#children
        .get(pending.attemptID)
        ?.send(JSON.stringify({ type: "stream-close", streamId: streamID }));
    } catch {
      /* The request is already failed and released. */
    }
  }

  #failAttemptStreams(attemptID: string, message: string) {
    this.processEvents.closeAttempt(attemptID);
    for (const [streamID, browser] of this.#browsers) {
      if (browser.socket.data.kind === "browser" && browser.socket.data.attemptID === attemptID) {
        browser.socket.close(1012, message);
        this.#browsers.delete(streamID);
        this.#browserStreams.delete(browser.socket);
      }
    }
    for (const [streamID, pending] of this.#pendingHTTP) {
      if (pending.attemptID === attemptID) this.#failHTTP(streamID, pending, message);
    }
    for (const [operationID, pending] of this.#pendingOperations) {
      if (pending.attemptID !== attemptID) continue;
      clearTimeout(pending.timer);
      this.#pendingOperations.delete(operationID);
      pending.reject(new Error(message));
    }
    for (const [operationID, pending] of this.#pendingChildOperations) {
      if (pending.attemptID !== attemptID) continue;
      clearTimeout(pending.timer);
      this.#pendingChildOperations.delete(operationID);
      pending.reject(new Error(message));
    }
  }
}

function isAppProcessName(value: string | undefined): value is string {
  return value === "app" || /^app-[a-z][a-z0-9-]{0,26}$/.test(value ?? "");
}

export function safeRuntimeHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    switch (name.toLowerCase()) {
      case "authorization":
      case "cookie":
      case "connection":
      case "host":
      case "origin":
      case "proxy-authorization":
      case "sec-websocket-key":
      case "sec-websocket-version":
      case "sec-websocket-protocol":
      case "sec-websocket-extensions":
      case "upgrade":
      case "x-forwarded-host":
      case "x-forwarded-proto":
      case "x-forwarded-prefix":
      case "forwarded":
        break;
      default:
        result[name] = value;
    }
  }
  return result;
}

export function appRuntimeHeaders(request: Request, path: string) {
  const headers = safeRuntimeHeaders(request.headers);
  const url = factoryRequestURL(request, process.env["FACTORY_BASE_URL"]);
  const prefix = url.pathname.slice(0, url.pathname.length - new URL(path, url).pathname.length);
  // Internal health/browser-tool requests deliberately have no browser proxy
  // context. They never receive cookies or caller-supplied forwarding headers.
  if (!url.pathname.startsWith("/runtime/")) return headers;
  if (!/^\/runtime\/[a-f0-9-]{36}\/(app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)$/.test(prefix))
    throw new Error("App runtime path is not scoped");
  headers["x-forwarded-host"] = url.host;
  headers["x-forwarded-proto"] = url.protocol.slice(0, -1);
  headers["x-forwarded-prefix"] = prefix;
  if (request.headers.get("origin") === url.origin) headers["origin"] = url.origin;
  const cookies = request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .filter((value) => {
      const name = value.slice(0, value.indexOf("="));
      return (
        /^[A-Za-z0-9._~-]+$/.test(name) &&
        !/^(?:__Host-|__Secure-)?(?:factory[._-]|better-auth[._-]|theia-connection-token)/i.test(
          name,
        )
      );
    });
  if (cookies?.length) headers["cookie"] = cookies.join("; ");
  return headers;
}

export function appRuntimeSocketContext(request: Request, path: string) {
  const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
  return {
    headers: appRuntimeHeaders(request, path),
    ...(protocol && /^[!#$%&'*+.^_`|~A-Za-z0-9-]{1,128}$/.test(protocol) ? { protocol } : {}),
  };
}

export function theiaConnectionToken(headers: Headers) {
  const cookie = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("theia-connection-token="));
  const token = cookie?.slice("theia-connection-token=".length);
  return token && token.length <= 256 && /^[A-Za-z0-9._~-]+$/.test(token) ? token : undefined;
}

// An untrusted App cannot set Factory/IDE credentials or cookies for other
// runtime paths. Preserve values/expiry, but bind browser state to its runtime
// path and top-level site so sessions also work in Factory's cross-site iframe.
export function scopeAppCookies(response: Response, path: string) {
  if (!/^\/runtime\/[a-f0-9-]{36}\/(app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)$/.test(path))
    throw new Error("App cookie path is not scoped");
  const headers = new Headers(response.headers);
  const cookies = headers
    .getSetCookie()
    .flatMap((value) => value.split(/,(?=\s*[A-Za-z0-9._~-]+=)/));
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    const [pair, ...attributes] = cookie.split(";").map((value) => value.trim());
    if (!pair) continue;
    const name = pair.slice(0, pair.indexOf("="));
    if (
      !/^[A-Za-z0-9._~-]+$/.test(name) ||
      /^(?:__Host-|(?:__Secure-)?(?:factory[._-]|better-auth[._-]|theia-connection-token))/i.test(
        name,
      )
    )
      continue;
    const safe = attributes.filter(
      (value) => !/^(?:domain|path|samesite|secure|partitioned)(?:\s*=|$)/i.test(value),
    );
    headers.append(
      "set-cookie",
      [pair, ...safe, `Path=${path}`, "SameSite=None", "Secure", "Partitioned"].join("; "),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function scopeTheiaConnectionCookie(response: Response, runtimePath: string) {
  const setCookie = response.headers.get("set-cookie");
  const token = setCookie?.match(/(?:^|,\s*)theia-connection-token=([^;]+)/)?.[1];
  if (!token || !/^[A-Za-z0-9._~-]{1,256}$/.test(token)) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "set-cookie",
    `theia-connection-token=${token}; Path=${runtimePath}; HttpOnly; SameSite=None; Secure; Partitioned`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
