import type { ServerWebSocket } from "bun";
import { BrowserAppStreamManager } from "./hub-browser-app-streams";
import type { RuntimeChannelState } from "./hub-channels";
import { HTTPStreamManager } from "./hub-http-streams";
import type { BrowserAppIdentity, ConnectorMessage, RuntimeSocketData } from "./hub-types";

export type BrowserSocketFrame = { messageType: 1 | 2; data: string };

export type BrowserSocketStreamState =
  | {
      phase: "opening";
      socket: ServerWebSocket<RuntimeSocketData>;
      connector: ServerWebSocket<RuntimeSocketData>;
      pending: BrowserSocketFrame[];
    }
  | {
      phase: "ready";
      socket: ServerWebSocket<RuntimeSocketData>;
      connector: ServerWebSocket<RuntimeSocketData>;
    };

export class RuntimeStreamManager {
  readonly #channels: RuntimeChannelState;
  readonly #browsers = new Map<string, BrowserSocketStreamState>();
  readonly #browserStreams = new Map<ServerWebSocket<RuntimeSocketData>, string>();
  readonly #browserApps: BrowserAppStreamManager;
  readonly #http: HTTPStreamManager;

  constructor(channels: RuntimeChannelState) {
    this.#channels = channels;
    this.#browserApps = new BrowserAppStreamManager(channels);
    this.#http = new HTTPStreamManager(channels);
  }

  openBrowser(socket: ServerWebSocket<RuntimeSocketData>) {
    if (socket.data.kind !== "browser") return;
    if (this.#channels.idleClaims.has(socket.data.attemptID)) {
      socket.close(1013, "Runtime is stopping");
      return;
    }
    const child = this.#channels.children.get(socket.data.attemptID);
    if (!child) {
      socket.close(1013, "Runtime is not ready");
      return;
    }
    const streamID = crypto.randomUUID();
    this.#browsers.set(streamID, { phase: "opening", socket, connector: child, pending: [] });
    this.#browserStreams.set(socket, streamID);
    if (socket.data.channel === "terminal") this.#channels.touch(socket.data.attemptID);
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
  }

  messageBrowser(socket: ServerWebSocket<RuntimeSocketData>, raw: string | Buffer) {
    if (socket.data.kind !== "browser") return;
    // Only terminal input is human activity. Language traffic, App polling
    // and live-reload keepalives must not keep an unattended Workspace awake.
    if (socket.data.channel === "terminal" && Buffer.isBuffer(raw))
      this.#channels.touch(socket.data.attemptID);
    const streamID = this.#browserStreams.get(socket);
    const child = this.#channels.children.get(socket.data.attemptID);
    const stream = streamID ? this.#browsers.get(streamID) : undefined;
    if (!streamID || !child || !stream) return;
    const frame: BrowserSocketFrame = {
      messageType: typeof raw === "string" ? 1 : 2,
      data: Buffer.from(raw).toString("base64"),
    };
    if (stream.phase === "ready") {
      child.send(JSON.stringify({ type: "websocket-message", streamId: streamID, ...frame }));
    } else if (stream.pending.length < 16) {
      stream.pending.push(frame);
    } else {
      stream.socket.close(1009, "Too many frames before channel readiness");
    }
  }

  closeBrowser(socket: ServerWebSocket<RuntimeSocketData>) {
    if (socket.data.kind !== "browser") return;
    const streamID = this.#browserStreams.get(socket);
    if (streamID) {
      this.#channels.children
        .get(socket.data.attemptID)
        ?.send(JSON.stringify({ type: "stream-close", streamId: streamID }));
      this.#browsers.delete(streamID);
    }
    this.#browserStreams.delete(socket);
  }

  handleStreamMessage(socket: ServerWebSocket<RuntimeSocketData>, message: ConnectorMessage) {
    if (socket.data.kind !== "connector") return;
    const streamID = message.streamId;
    if (!streamID) return;
    if (this.#browserApps.handleMessage(socket, streamID, message)) return;
    if (this.#http.handleMessage(socket, streamID, message)) return;
    const browser = this.#browsers.get(streamID);
    if (
      !browser ||
      socket.data.role !== "child" ||
      browser.socket.data.attemptID !== socket.data.attemptID ||
      browser.connector !== socket ||
      this.#channels.children.get(socket.data.attemptID) !== socket
    )
      return;
    if (message.type === "websocket-ready") {
      if (browser.phase !== "opening") return;
      this.#browsers.set(streamID, {
        phase: "ready",
        socket: browser.socket,
        connector: browser.connector,
      });
      if (browser.socket.data.kind === "browser" && browser.socket.data.channel === "terminal") {
        browser.socket.send(JSON.stringify({ type: "terminal-ready" }));
      }
      for (const frame of browser.pending) {
        socket.send(JSON.stringify({ type: "websocket-message", streamId: streamID, ...frame }));
      }
    } else if (message.type === "websocket-message" && message.data) {
      const data = Buffer.from(message.data, "base64");
      browser.socket.send(message.messageType === 1 ? data.toString() : data);
    } else if (message.type === "stream-close" || message.type === "stream-error") {
      browser.socket.close(message.type === "stream-error" ? 1011 : 1000, message.error);
    }
  }

  openBrowserAppSocket(
    attemptID: string,
    channel: string,
    request: Request,
    path: string,
    identity: BrowserAppIdentity,
    beforeSend: (send: () => void) => Promise<void>,
  ) {
    return this.#browserApps.open(attemptID, channel, request, path, identity, beforeSend);
  }

  closeBrowserApp(streamID: string, reason?: string) {
    this.#browserApps.close(streamID, reason);
  }

  closeAttemptBrowserApps(attemptID: string, reason: string) {
    this.#browserApps.closeAttempt(attemptID, reason);
  }

  checkBrowserApps(attemptID: string) {
    this.#browserApps.checkAttempt(attemptID);
  }

  requestHTTP(
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
    return this.#http.request(
      attemptID,
      channel,
      request,
      path,
      requestHeaders,
      beforeSend,
      accessToken,
      appCookies,
    );
  }

  revokeAccess(accessToken: string) {
    for (const [streamID, browser] of this.#browsers) {
      if (
        browser.socket.data.kind === "browser" &&
        browser.socket.data.accessToken === accessToken
      ) {
        browser.socket.close(1008, "Runtime access revoked");
        this.closeBrowser(browser.socket);
        this.#browsers.delete(streamID);
      }
    }
    this.#http.revokeAccess(accessToken);
  }

  attended(attemptID: string) {
    if (this.#browserApps.hasAttempt(attemptID)) return true;
    for (const browser of this.#browsers.values())
      if (browser.socket.data.kind === "browser" && browser.socket.data.attemptID === attemptID)
        return true;
    return this.#http.hasAttempt(attemptID);
  }

  hasAwakeHTTP(attemptID: string) {
    return this.#http.hasAwake(attemptID);
  }

  failAttemptStreams(
    attemptID: string,
    message: string,
    connector?: ServerWebSocket<RuntimeSocketData>,
  ) {
    this.#browserApps.closeAttempt(attemptID, message, connector);
    // A native Source drain deliberately stops Child containers while Parent
    // confirms the frozen export. Only the disconnected socket's work failed;
    // suspend/revocation still invalidate every stream and operation below.
    if (!connector || (connector.data.kind === "connector" && connector.data.role === "child"))
      this.#channels.processEvents.closeAttempt(attemptID);
    for (const [streamID, browser] of this.#browsers) {
      if (
        browser.socket.data.kind === "browser" &&
        browser.socket.data.attemptID === attemptID &&
        (!connector || browser.connector === connector)
      ) {
        browser.socket.close(1012, message);
        this.#browsers.delete(streamID);
        this.#browserStreams.delete(browser.socket);
      }
    }
    this.#http.failAttempt(attemptID, message, connector);
  }
}
