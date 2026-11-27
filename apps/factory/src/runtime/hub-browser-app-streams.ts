import type { ServerWebSocket } from "bun";
import type { RuntimeChannelState } from "./hub-channels";
import {
  browserAppRequestHeaders,
  parseBrowserAppSocketProtocol,
  validateBrowserAppSocketPath,
} from "./hub-frames";
import {
  type BrowserAppFrame,
  type BrowserAppIdentity,
  type ConnectorMessage,
  createControlledStream,
  MAX_BROWSER_SOCKET_FRAME_BYTES,
  MAX_BROWSER_SOCKET_QUEUE_BYTES,
  type RuntimeSocketData,
} from "./hub-types";

export type BrowserAppStreamState =
  | {
      phase: "opening";
      attemptID: string;
      connector: ServerWebSocket<RuntimeSocketData>;
      protocol: string;
      controller: ReadableStreamDefaultController<BrowserAppFrame>;
      resolve(protocol: string): void;
      reject(error: Error): void;
      timer: Timer;
      detach(): void;
      assertCurrent(): void;
    }
  | {
      phase: "ready";
      attemptID: string;
      connector: ServerWebSocket<RuntimeSocketData>;
      protocol: string;
      bytes: number;
      controller: ReadableStreamDefaultController<BrowserAppFrame>;
      detach(): void;
      assertCurrent(): void;
    };

type BrowserAppStreamEntry = { state: BrowserAppStreamState };

export class BrowserAppStreamManager {
  readonly #channels: RuntimeChannelState;
  readonly #streams = new Map<string, BrowserAppStreamEntry>();

  constructor(channels: RuntimeChannelState) {
    this.#channels = channels;
  }

  hasAttempt(attemptID: string) {
    for (const { state } of this.#streams.values()) if (state.attemptID === attemptID) return true;
    return false;
  }

  // An isolated Browser uses the existing Child App WebSocket protocol. Every
  // opening/data send keeps the original Actor, Child, generation and App target.
  async open(
    attemptID: string,
    channel: string,
    request: Request,
    path: string,
    identity: BrowserAppIdentity,
    beforeSend: (send: () => void) => Promise<void>,
  ) {
    const expected = { ...identity };
    const child = this.#channels.children.get(attemptID);
    if (!child) throw new Error("Browser App WebSocket requires its original Child");
    const authority = this.#channels.tokens.get(attemptID);
    const current = () => {
      request.signal.throwIfAborted();
      this.#channels.requireBrowserAppChannel(attemptID, channel);
      const live = this.#channels.tokens.get(attemptID);
      if (
        !authority ||
        !live ||
        this.#channels.children.get(attemptID) !== child ||
        live.actorUID !== authority.actorUID ||
        live.generation !== authority.generation ||
        live.parentHash !== authority.parentHash ||
        live.childHash !== authority.childHash ||
        authority.actorUID !== expected.actorUID ||
        authority.generation !== expected.generation ||
        child.data.kind !== "connector" ||
        child.data.generation !== expected.generation ||
        this.#channels.appTargets.get(attemptID)?.get(channel) !== expected.target ||
        this.#channels.idleClaims.has(attemptID)
      )
        throw new Error("Browser App WebSocket execution changed");
    };
    current();
    if (request.method !== "GET" || this.#streams.size >= 32)
      throw new Error("Browser App WebSocket is not available");
    validateBrowserAppSocketPath(path);
    // This isolated Browser-only entrypoint separates bounded App credentials
    // from ordinary headers; public Runtime sockets never carry this field.
    const context = browserAppRequestHeaders(request.headers);
    const selected = parseBrowserAppSocketProtocol(request.headers);
    const streamID = crypto.randomUUID();
    const ready = Promise.withResolvers<string>();
    void ready.promise.catch(() => {});
    const { stream: messages, controller } = createControlledStream<BrowserAppFrame>(
      () => this.close(streamID),
      {
        highWaterMark: MAX_BROWSER_SOCKET_QUEUE_BYTES,
        size: (value) => Math.max(value?.data.byteLength ?? 1, MAX_BROWSER_SOCKET_QUEUE_BYTES / 16),
      },
    );
    const abort = () => this.close(streamID, "Browser App WebSocket was cancelled");
    request.signal.addEventListener("abort", abort, { once: true });
    const entry: BrowserAppStreamEntry = {
      state: {
        phase: "opening",
        attemptID,
        connector: child,
        protocol: selected,
        controller,
        resolve: ready.resolve,
        reject: ready.reject,
        timer: setTimeout(
          () => this.close(streamID, "Browser App WebSocket was not ready"),
          25_000,
        ),
        detach: () => request.signal.removeEventListener("abort", abort),
        assertCurrent: current,
      },
    };
    this.#streams.set(streamID, entry);
    let dispatched = false;
    const transmit = (frame: object) => {
      current();
      if (this.#streams.get(streamID) !== entry) throw new Error("Browser App WebSocket ended");
      const encoded = JSON.stringify(frame);
      if (
        child.getBufferedAmount() + Buffer.byteLength(encoded) > MAX_BROWSER_SOCKET_QUEUE_BYTES ||
        child.send(encoded) === 0
      )
        throw new Error("Browser App WebSocket send was not confirmed");
    };
    try {
      await beforeSend(() => {
        if (dispatched) throw new Error("Browser App WebSocket was already dispatched");
        dispatched = true;
        transmit({
          type: "websocket-open",
          streamId: streamID,
          channel,
          path,
          ...context,
          ...(selected ? { protocol: selected } : {}),
        });
      });
      if (!dispatched) throw new Error("Browser App WebSocket was not admitted");
      const protocol = await ready.promise;
      current();
      let queued = 0;
      let sending = Promise.resolve();
      return {
        protocol,
        messages,
        send: (messageType: 1 | 2, data: Uint8Array) => {
          if (![1, 2].includes(messageType) || data.byteLength > MAX_BROWSER_SOCKET_FRAME_BYTES) {
            this.close(streamID, "Browser App WebSocket frame exceeds its bound");
            return Promise.reject(new Error("Browser App WebSocket frame exceeds its bound"));
          }
          if (++queued > 16) {
            this.close(streamID, "Browser App WebSocket input exceeds its bound");
            return Promise.reject(new Error("Browser App WebSocket input exceeds its bound"));
          }
          const encoded = Buffer.from(data).toString("base64");
          const next = sending.then(async () => {
            let sent = false;
            await beforeSend(() => {
              if (sent) throw new Error("Browser App WebSocket frame was already dispatched");
              sent = true;
              transmit({
                type: "websocket-message",
                streamId: streamID,
                messageType,
                data: encoded,
              });
            });
            if (!sent) throw new Error("Browser App WebSocket frame was not admitted");
          });
          sending = next.catch(() => {
            this.close(streamID, "Browser App WebSocket authority ended");
          });
          return next.finally(() => queued--);
        },
        close: () => this.close(streamID),
      };
    } catch (cause) {
      this.close(streamID, "Browser App WebSocket was not admitted");
      throw cause;
    }
  }

  handleMessage(
    socket: ServerWebSocket<RuntimeSocketData>,
    streamID: string,
    message: ConnectorMessage,
  ): boolean {
    const entry = this.#streams.get(streamID);
    if (!entry) return false;
    if (
      socket.data.kind !== "connector" ||
      socket.data.role !== "child" ||
      entry.state.connector !== socket ||
      entry.state.attemptID !== socket.data.attemptID
    )
      return true;
    try {
      entry.state.assertCurrent();
      if (message.type === "websocket-ready") {
        const current = entry.state;
        if (
          current.phase !== "opening" ||
          (message.protocol && message.protocol !== current.protocol)
        )
          throw new Error("Browser App WebSocket readiness changed");
        clearTimeout(current.timer);
        entry.state = {
          phase: "ready",
          attemptID: current.attemptID,
          connector: current.connector,
          protocol: current.protocol,
          bytes: 0,
          controller: current.controller,
          detach: current.detach,
          assertCurrent: current.assertCurrent,
        };
        current.resolve(message.protocol ?? "");
      } else if (message.type === "websocket-message") {
        const current = entry.state;
        const data = Buffer.from(message.data ?? "", "base64");
        if (
          current.phase !== "ready" ||
          (message.messageType !== 1 && message.messageType !== 2) ||
          data.toString("base64") !== (message.data ?? "") ||
          data.byteLength > MAX_BROWSER_SOCKET_FRAME_BYTES ||
          current.bytes + data.byteLength > 16 << 20 ||
          // Count empty frames as well, so they cannot make an unbounded queue.
          Math.max(1, data.byteLength) > (current.controller.desiredSize ?? 0)
        )
          throw new Error("Browser App WebSocket output exceeds its bound");
        current.bytes += data.byteLength;
        current.controller.enqueue({ messageType: message.messageType, data });
      } else if (message.type === "stream-close") {
        this.close(streamID);
      } else if (message.type === "stream-error") {
        // App/infrastructure diagnostics can contain credentials.
        this.close(streamID, "Browser App WebSocket ended");
      }
    } catch {
      this.close(streamID, "Browser App WebSocket output was not confirmed");
    }
    return true;
  }

  close(streamID: string, reason?: string) {
    const entry = this.#streams.get(streamID);
    if (!entry) return;
    this.#streams.delete(streamID);
    const { state } = entry;
    state.detach();
    if (state.phase === "opening") {
      clearTimeout(state.timer);
      state.reject(new Error(reason ?? "Browser App WebSocket ended"));
    }
    try {
      if (reason) state.controller.error(new Error(reason));
      else state.controller.close();
    } catch {
      /* The consumer may already have cancelled its readable side. */
    }
    try {
      state.connector.send(JSON.stringify({ type: "stream-close", streamId: streamID }));
    } catch {
      /* Release is final; never reconnect or send through another Child. */
    }
  }

  closeAttempt(attemptID: string, reason: string, connector?: ServerWebSocket<RuntimeSocketData>) {
    for (const [streamID, { state }] of this.#streams)
      if (state.attemptID === attemptID && (!connector || state.connector === connector))
        this.close(streamID, reason);
  }

  checkAttempt(attemptID: string) {
    for (const [streamID, { state }] of this.#streams) {
      if (state.attemptID !== attemptID) continue;
      try {
        state.assertCurrent();
      } catch {
        this.close(streamID, "Browser App WebSocket execution changed");
      }
    }
  }
}
