import type { ServerWebSocket } from "bun";
import { RuntimeChannelState } from "./hub-channels";
import {
  appRuntimeHeaders,
  browserAppRequestHeaders,
  safeRuntimeHeaders,
  theiaConnectionToken,
} from "./hub-frames";
import { RuntimeOperationManager } from "./hub-operations";
import { RuntimeStreamManager } from "./hub-streams";
import {
  type BrowserAppIdentity,
  type ConnectorMessage,
  HUB_PROTOCOL,
  type ParentOperationResult,
  type RuntimeSocketData,
} from "./hub-types";
import type { RuntimeProcessSnapshot } from "./process-contract";
import type { RuntimeProcessEvents } from "./process-events";

export {
  appRuntimeHeaders,
  appRuntimeSocketContext,
  safeRuntimeHeaders,
  scopeAppCookies,
  scopeTheiaConnectionCookie,
  theiaConnectionToken,
} from "./hub-frames";
export { RuntimeParentOperationError, type RuntimeSocketData } from "./hub-types";

export class RuntimeHub {
  readonly #channels: RuntimeChannelState;
  readonly #streams: RuntimeStreamManager;
  readonly #operations: RuntimeOperationManager;
  readonly processEvents: RuntimeProcessEvents;

  constructor(
    onStatus: (attemptID: string, phase: string, error?: string) => Promise<void>,
    now = Date.now,
  ) {
    this.#channels = new RuntimeChannelState(onStatus, now);
    this.#streams = new RuntimeStreamManager(this.#channels);
    this.#operations = new RuntimeOperationManager(this.#channels);
    this.processEvents = this.#channels.processEvents;
  }

  /** Called when a declared App process first reports running after not running. */
  onAppRunning(listener: (attemptID: string, app: string) => void) {
    this.#channels.onAppRunning(listener);
  }

  allow(
    attemptID: string,
    generation: number,
    parentHash: string,
    childHash: string,
    actorUID?: string,
  ) {
    this.#channels.allow(attemptID, generation, parentHash, childHash, actorUID);
    this.#streams.checkBrowserApps(attemptID);
  }

  authorize(request: Request, hashToken: (token: string) => string): RuntimeSocketData | null {
    return this.#channels.authorize(request, hashToken);
  }

  open(socket: ServerWebSocket<RuntimeSocketData>) {
    if (socket.data.kind === "browser") {
      this.#streams.openBrowser(socket);
      return;
    }
    this.#channels.openConnector(socket);
  }

  message(socket: ServerWebSocket<RuntimeSocketData>, raw: string | Buffer) {
    if (socket.data.kind === "browser") {
      this.#streams.messageBrowser(socket, raw);
      return;
    }
    if (!this.#channels.isCurrentConnector(socket)) return;
    const message = JSON.parse(String(raw)) as ConnectorMessage;
    if (
      this.#channels.handleLifecycleMessage(socket, message, (attemptID) =>
        this.#streams.checkBrowserApps(attemptID),
      )
    )
      return;
    if (this.#operations.handleOperationResponse(socket, message)) return;
    this.#streams.handleStreamMessage(socket, message);
  }

  close(socket: ServerWebSocket<RuntimeSocketData>) {
    if (socket.data.kind === "browser") {
      this.#streams.closeBrowser(socket);
      return;
    }
    this.#channels.closeConnector(socket, (attemptID, message, connector) =>
      this.#failAttemptStreams(attemptID, message, connector),
    );
  }

  async request(
    attemptID: string,
    channel: string,
    request: Request,
    path: string,
    beforeSend?: (send: () => void) => Promise<void>,
    accessToken?: string,
    originScoped = false,
  ) {
    return this.#streams.requestHTTP(
      attemptID,
      channel,
      request,
      path,
      () => ({
        headers:
          channel === "source"
            ? { "x-factory-writer-epoch": request.headers.get("X-Factory-Writer-Epoch") ?? "" }
            : this.hasAppChannel(attemptID, channel)
              ? appRuntimeHeaders(request, path, originScoped)
              : safeRuntimeHeaders(request.headers),
        ...(channel === "ide"
          ? { theiaConnectionToken: theiaConnectionToken(request.headers) }
          : {}),
      }),
      beforeSend,
      accessToken,
      () =>
        this.hasAppChannel(attemptID, channel) &&
        new URL(request.url).pathname.startsWith("/runtime/")
          ? {
              appPath: new URL(request.url).pathname.slice(
                0,
                new URL(request.url).pathname.length - new URL(path, request.url).pathname.length,
              ),
              originScopedCookies: originScoped,
            }
          : {},
    );
  }

  // Internal native Browser relay only: request carries isolated App credentials,
  // never Factory endpoint authentication. Its owner must authorize the actual send.
  async requestBrowserApp(
    attemptID: string,
    channel: string,
    request: Request,
    path: string,
    beforeSend: (send: () => void) => Promise<void>,
  ) {
    this.#channels.requireBrowserAppChannel(attemptID, channel);
    return this.#streams.requestHTTP(
      attemptID,
      channel,
      request,
      path,
      () => {
        this.#channels.requireBrowserAppChannel(attemptID, channel);
        return browserAppRequestHeaders(request.headers);
      },
      async (send) => beforeSend(send),
    );
  }

  // An isolated Browser uses the existing Child App WebSocket protocol. Every
  // opening/data send keeps the original Actor, Child, generation and App target.
  async openBrowserAppSocket(
    attemptID: string,
    channel: string,
    request: Request,
    path: string,
    identity: BrowserAppIdentity,
    beforeSend: (send: () => void) => Promise<void>,
  ) {
    return this.#streams.openBrowserAppSocket(
      attemptID,
      channel,
      request,
      path,
      identity,
      beforeSend,
    );
  }

  async parentOperation(
    attemptID: string,
    operation: Record<string, string | number> & { operationId: string; action: string },
    beforeSend?: (send: () => void) => Promise<void>,
  ): Promise<ParentOperationResult> {
    return this.#operations.parentOperation(attemptID, operation, beforeSend);
  }

  async childOperation(attemptID: string, operation: Record<string, string>): Promise<void> {
    return this.#operations.childOperation(attemptID, operation);
  }

  async childRequest(
    attemptID: string,
    operation: Record<string, string>,
    beforeSend?: (send: () => void) => Promise<void>,
  ): Promise<string | undefined> {
    return this.#operations.childRequest(attemptID, operation, beforeSend);
  }

  onCommandState(listener: (attemptID: string, data: string) => void) {
    return this.#channels.onCommandState(listener);
  }

  stop(attemptID: string) {
    this.#channels.tokens.delete(attemptID);
    this.#streams.closeAttemptBrowserApps(attemptID, "Browser App WebSocket authority ended");
    return this.#channels.stop(attemptID);
  }

  suspend(attemptID: string) {
    this.#failAttemptStreams(attemptID, "Runtime is stopping");
  }

  revokeAccess(accessToken: string) {
    this.processEvents.revokeAccess(accessToken);
    this.#streams.revokeAccess(accessToken);
  }

  revoke(attemptID: string) {
    this.#channels.revoke(attemptID);
    this.#failAttemptStreams(attemptID, "Runtime stopped");
  }

  connected(attemptID: string) {
    return this.#channels.connected(attemptID);
  }

  ready(attemptID: string) {
    return this.#channels.ready(attemptID);
  }

  parentConnected(attemptID: string) {
    return this.#channels.parentConnected(attemptID);
  }

  sourceConnected(attemptID: string) {
    return this.#channels.sourceConnected(attemptID);
  }

  sourceEpoch(attemptID: string) {
    return this.#channels.sourceEpoch(attemptID);
  }

  use(attemptID: string) {
    return this.#channels.use(attemptID);
  }

  /** Whether an IDE, Terminal or App socket, or any browser HTTP request, is open for this attempt. */
  attended(attemptID: string) {
    return this.#streams.attended(attemptID);
  }

  // An unattended Workspace (no open connection, nothing in flight) may pause
  // after quietMS. Every other fence below applies to both thresholds.
  claimIdle(attemptID: string, idleMS: number, quietMS = idleMS) {
    return this.#channels.claimIdle(
      attemptID,
      idleMS,
      quietMS,
      this.attended(attemptID),
      this.#streams.hasAwakeHTTP(attemptID) || this.#operations.hasPendingForAttempt(attemptID),
    );
  }

  releaseIdle(attemptID: string) {
    this.#channels.releaseIdle(attemptID);
  }

  processes(attemptID: string): RuntimeProcessSnapshot[] {
    return this.#channels.processes(attemptID);
  }

  hasAppChannel(attemptID: string, channel: string) {
    return this.#channels.hasAppChannel(attemptID, channel);
  }

  appChannels(attemptID: string) {
    return this.#channels.appChannels(attemptID);
  }

  static protocol() {
    return HUB_PROTOCOL;
  }

  #failAttemptStreams(
    attemptID: string,
    message: string,
    connector?: ServerWebSocket<RuntimeSocketData>,
  ) {
    this.#streams.failAttemptStreams(attemptID, message, connector);
    this.#operations.failAttemptOperations(attemptID, message, connector);
  }
}
