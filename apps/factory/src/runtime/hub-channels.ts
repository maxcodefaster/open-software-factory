import type { ServerWebSocket } from "bun";
import { isAppProcessName } from "./hub-frames";
import type {
  AttemptActivity,
  ConnectorAuthority,
  ConnectorMessage,
  ProcessMap,
  RuntimeSocketData,
  StatusObservation,
} from "./hub-types";
import type { RuntimeProcessSnapshot } from "./process-contract";
import { RuntimeProcessEvents } from "./process-events";

export class RuntimeChannelState {
  readonly terminalSockets = new WeakSet<ServerWebSocket<RuntimeSocketData>>();
  readonly failedSourceParents = new WeakSet<ServerWebSocket<RuntimeSocketData>>();
  readonly parents = new Map<string, ServerWebSocket<RuntimeSocketData>>();
  readonly children = new Map<string, ServerWebSocket<RuntimeSocketData>>();
  readonly readyChildren = new WeakSet<ServerWebSocket<RuntimeSocketData>>();
  readonly sourceParents = new WeakSet<ServerWebSocket<RuntimeSocketData>>();
  readonly sourceEpochs = new WeakMap<ServerWebSocket<RuntimeSocketData>, number>();
  readonly tokens = new Map<string, ConnectorAuthority>();
  readonly commandCounts = new Map<string, number>();
  readonly commandListeners = new Set<(attemptID: string, data: string) => void>();
  readonly disconnectTimers = new Map<string, Timer>();
  readonly statusObservations = new Map<string, StatusObservation>();
  readonly #processes = new Map<string, ProcessMap>();
  readonly processEvents = new RuntimeProcessEvents((attemptID) => this.processes(attemptID));
  readonly #appChannels = new Map<string, Set<string>>();
  readonly appTargets = new Map<string, Map<string, string>>();
  readonly #onStatus: (attemptID: string, phase: string, error?: string) => Promise<void>;
  readonly #activity = new Map<string, AttemptActivity>();
  readonly idleClaims = new Set<string>();
  readonly #appRunning: Array<(attemptID: string, app: string) => void> = [];
  readonly #now: () => number;

  constructor(
    onStatus: (attemptID: string, phase: string, error?: string) => Promise<void>,
    now: () => number = Date.now,
  ) {
    this.#onStatus = onStatus;
    this.#now = now;
  }

  onAppRunning(listener: (attemptID: string, app: string) => void) {
    this.#appRunning.push(listener);
  }

  onCommandState(listener: (attemptID: string, data: string) => void) {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  observeStatus(producer: ServerWebSocket<RuntimeSocketData>, phase: string, error?: string) {
    if (producer.data.kind !== "connector") return;
    const { attemptID, role } = producer.data;
    const authority = this.tokens.get(attemptID);
    const key = `${attemptID}:${role}`;
    const terminal = ["stopped", "failed", "cleanup-failed"].includes(phase);
    const previous = this.statusObservations.get(key);
    if (previous && previous.authority === authority && previous.terminal && !terminal) return;
    if (previous?.timer) clearTimeout(previous.timer);
    const observation: StatusObservation = { authority, terminal };
    this.statusObservations.set(key, observation);
    const forget = () => {
      if (this.statusObservations.get(key) !== observation) return;
      if (observation.timer) clearTimeout(observation.timer);
      this.statusObservations.delete(key);
    };
    const relevant = () => {
      if (
        !authority ||
        this.tokens.get(attemptID) !== authority ||
        this.statusObservations.get(key) !== observation
      )
        return false;
      if (terminal) return true;
      const current = role === "parent" ? this.parents : this.children;
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

  allow(
    attemptID: string,
    generation: number,
    parentHash: string,
    childHash: string,
    actorUID?: string,
  ) {
    this.tokens.set(attemptID, {
      parentHash,
      childHash,
      generation,
      ...(actorUID ? { actorUID } : {}),
    });
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
    const expected = this.tokens.get(attemptID);
    if (
      !expected ||
      expected.generation !== generation ||
      (expected.actorUID !== undefined &&
        request.headers.get("x-factory-runtime-actor-uid") !== expected.actorUID) ||
      (role === "parent" ? expected.parentHash : expected.childHash) !==
        hashToken(authorization.slice(7))
    )
      return null;
    return { kind: "connector", role, attemptID, generation };
  }

  openConnector(socket: ServerWebSocket<RuntimeSocketData>) {
    if (socket.data.kind !== "connector") return;
    const connections = socket.data.role === "parent" ? this.parents : this.children;
    if (connections.has(socket.data.attemptID)) {
      socket.close(1008, "Connector role is already connected");
      return;
    }
    this.readyChildren.delete(socket);
    this.sourceParents.delete(socket);
    this.failedSourceParents.delete(socket);
    connections.set(socket.data.attemptID, socket);
    this.touch(socket.data.attemptID);
  }

  isCurrentConnector(socket: ServerWebSocket<RuntimeSocketData>): boolean {
    if (socket.data.kind !== "connector") return false;
    const current = socket.data.role === "parent" ? this.parents : this.children;
    return current.get(socket.data.attemptID) === socket;
  }

  /**
   * Handles connector lifecycle, terminal, command, process, and hello/status
   * messages. Returns true if the message was fully consumed.
   */
  handleLifecycleMessage(
    socket: ServerWebSocket<RuntimeSocketData>,
    message: ConnectorMessage,
    checkBrowserApps: (attemptID: string) => void,
  ): boolean {
    if (socket.data.kind !== "connector") return false;
    if (
      message.type === "status" &&
      ["stopped", "failed", "cleanup-failed"].includes(message.phase ?? "")
    ) {
      this.terminalSockets.add(socket);
      checkBrowserApps(socket.data.attemptID);
      if (
        socket.data.role === "parent" &&
        message.phase === "failed" &&
        this.sourceParents.has(socket)
      )
        this.failedSourceParents.add(socket);
      else this.failedSourceParents.delete(socket);
    }
    if (socket.data.role === "child" && message.type === "hello" && message.role === "child") {
      this.readyChildren.add(socket);
      const activity = this.#activity.get(socket.data.attemptID);
      if (activity) {
        activity.terminals = null;
        activity.busyTerminals = null;
        activity.revision = -1;
      }
      this.observeTerminals(socket.data.attemptID, message);
      this.commandCounts.set(socket.data.attemptID, message.commandCount ?? 0);
      const timer = this.disconnectTimers.get(`${socket.data.attemptID}:child`);
      if (timer) clearTimeout(timer);
      this.disconnectTimers.delete(`${socket.data.attemptID}:child`);
      const setup = this.#processes.get(socket.data.attemptID)?.get("setup");
      this.#processes.delete(socket.data.attemptID);
      if (setup) this.#processes.set(socket.data.attemptID, new Map([["setup", setup]]));
      this.processEvents.changed(socket.data.attemptID);
      const channels = new Set<string>();
      const targets = new Map<string, string>();
      for (const channel of message.channels ?? []) {
        if (channel.kind === "app" && isAppProcessName(channel.name)) {
          channels.add(channel.name);
          if (typeof channel.target === "string") targets.set(channel.name, channel.target);
        }
      }
      this.#appChannels.set(socket.data.attemptID, channels);
      this.appTargets.set(socket.data.attemptID, targets);
      checkBrowserApps(socket.data.attemptID);
      if (this.ready(socket.data.attemptID)) {
        this.observeStatus(socket, "ready");
      }
      return true;
    }
    if (socket.data.role === "child" && message.type === "terminal-state") {
      this.observeTerminals(socket.data.attemptID, message);
      if (
        typeof message.commandCount === "number" &&
        Number.isSafeInteger(message.commandCount) &&
        message.commandCount >= 0 &&
        message.commandCount <= 8
      )
        this.commandCounts.set(socket.data.attemptID, message.commandCount);
      return true;
    }
    if (socket.data.role === "child" && message.type === "command-state") {
      if (
        typeof message.commandCount === "number" &&
        Number.isSafeInteger(message.commandCount) &&
        message.commandCount >= 0 &&
        message.commandCount <= 8
      )
        this.commandCounts.set(socket.data.attemptID, message.commandCount);
      if (message.data && message.data.length <= 16_384)
        for (const listener of this.commandListeners) listener(socket.data.attemptID, message.data);
      return true;
    }
    if (socket.data.role === "child" && message.type === "status" && message.phase) {
      this.observeStatus(socket, message.phase, message.error);
      return true;
    }
    const processName = (
      socket.data.role === "parent"
        ? message.process === "setup"
        : isAppProcessName(message.process)
    )
      ? message.process
      : undefined;
    if (
      processName &&
      message.type === "process-state" &&
      (message.processState === "starting" ||
        message.processState === "running" ||
        message.processState === "stopping" ||
        message.processState === "stopped" ||
        message.processState === "failed")
    ) {
      const process = this.#process(socket.data.attemptID, processName);
      if (!process) return true;
      const wasRunning = process.state === "running";
      process.state = message.processState;
      if (socket.data.role === "child" && message.processState === "running" && !wasRunning)
        for (const listener of this.#appRunning) listener(socket.data.attemptID, processName);
      if (processName === "setup") {
        process.label = "Project setup";
      } else if (message.processLabel?.trim() && message.processLabel.length <= 64) {
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
      return true;
    }
    if (
      processName &&
      message.type === "process-output" &&
      message.data &&
      message.data.length <= 48 << 10
    ) {
      const process = this.#process(socket.data.attemptID, processName);
      if (!process) return true;
      const output = Buffer.from(message.data, "base64").toString("utf8");
      const combined = `${process.output}${output}`;
      const tail = combined.slice(-(32 << 10));
      process.output =
        processName === "setup" && combined.length > tail.length
          ? tail.replace(/^[^\n]*\n?/, "")
          : tail;
      this.processEvents.changed(socket.data.attemptID);
      return true;
    }
    if (socket.data.role === "parent" && message.type === "status" && message.phase) {
      const timer = this.disconnectTimers.get(`${socket.data.attemptID}:parent`);
      if (timer) clearTimeout(timer);
      this.disconnectTimers.delete(`${socket.data.attemptID}:parent`);
      this.observeStatus(socket, message.phase, message.error);
      return true;
    }
    if (socket.data.role === "parent" && message.type === "hello" && message.role === "parent") {
      if (
        message.channels?.some((channel) => channel.name === "source" && channel.kind === "source")
      ) {
        this.sourceParents.add(socket);
        const epoch = message["sourceEpoch"];
        if (typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0)
          this.sourceEpochs.set(socket, epoch);
        else this.sourceEpochs.delete(socket);
      } else {
        this.sourceParents.delete(socket);
        this.sourceEpochs.delete(socket);
      }
      const timer = this.disconnectTimers.get(`${socket.data.attemptID}:parent`);
      if (timer) clearTimeout(timer);
      this.disconnectTimers.delete(`${socket.data.attemptID}:parent`);
      if (this.ready(socket.data.attemptID)) {
        this.observeStatus(socket, "ready");
      } else if (this.sourceParents.has(socket)) {
        this.observeStatus(socket, "source-ready");
      }
      return true;
    }
    return false;
  }

  closeConnector(
    socket: ServerWebSocket<RuntimeSocketData>,
    failAttemptStreams: (
      attemptID: string,
      message: string,
      connector?: ServerWebSocket<RuntimeSocketData>,
    ) => void,
  ) {
    if (socket.data.kind !== "connector") return;
    const connections = socket.data.role === "parent" ? this.parents : this.children;
    if (connections.get(socket.data.attemptID) === socket) {
      const role = socket.data.role;
      const attemptID = socket.data.attemptID;
      connections.delete(socket.data.attemptID);
      if (role === "parent" && this.#processes.get(attemptID)?.delete("setup"))
        this.processEvents.changed(attemptID);
      failAttemptStreams(attemptID, "Runtime channel disconnected", socket);
      if (this.terminalSockets.has(socket)) return;
      this.observeStatus(socket, "reconnecting", `${role} connector reconnecting`);
      const timerKey = `${attemptID}:${role}`;
      const previous = this.disconnectTimers.get(timerKey);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.disconnectTimers.delete(timerKey);
        const reconnected =
          role === "child" ? this.children.has(attemptID) : this.parents.has(attemptID);
        if (!reconnected) {
          this.observeStatus(socket, "disconnected", `${role} connector did not reconnect`);
        }
      }, 15_000);
      this.disconnectTimers.set(timerKey, timer);
    }
  }

  stop(attemptID: string) {
    this.tokens.delete(attemptID);
    const parent = this.parents.get(attemptID);
    if (!parent) return false;
    const sent = parent.send(JSON.stringify({ type: "stop" }));
    if (sent === 0) return false;
    return true;
  }

  revoke(attemptID: string) {
    this.#activity.delete(attemptID);
    this.idleClaims.delete(attemptID);
    this.tokens.delete(attemptID);
    for (const role of ["parent", "child"]) {
      const key = `${attemptID}:${role}`;
      const observation = this.statusObservations.get(key);
      if (observation?.timer) clearTimeout(observation.timer);
      this.statusObservations.delete(key);
      const disconnected = this.disconnectTimers.get(key);
      if (disconnected) clearTimeout(disconnected);
      this.disconnectTimers.delete(key);
    }
    const parent = this.parents.get(attemptID);
    const child = this.children.get(attemptID);
    this.parents.delete(attemptID);
    this.children.delete(attemptID);
    this.#processes.delete(attemptID);
    this.commandCounts.delete(attemptID);
    this.#appChannels.delete(attemptID);
    this.appTargets.delete(attemptID);
    parent?.close(1000, "Runtime stopped");
    child?.close(1000, "Runtime stopped");
  }

  connected(attemptID: string) {
    return this.parents.has(attemptID) && this.children.has(attemptID);
  }

  ready(attemptID: string) {
    const parent = this.parents.get(attemptID);
    const child = this.children.get(attemptID);
    // The child opens its transport before starting processes and checking
    // App health. Only its later hello confirms those checks have finished.
    return !!(
      parent &&
      child &&
      this.readyChildren.has(child) &&
      !this.terminalSockets.has(parent) &&
      !this.terminalSockets.has(child)
    );
  }

  parentConnected(attemptID: string) {
    return this.parents.has(attemptID);
  }

  sourceConnected(attemptID: string) {
    const parent = this.parents.get(attemptID);
    return Boolean(
      parent &&
        this.sourceParents.has(parent) &&
        (!this.terminalSockets.has(parent) || this.failedSourceParents.has(parent)),
    );
  }

  sourceEpoch(attemptID: string) {
    const parent = this.parents.get(attemptID);
    return parent && this.sourceConnected(attemptID) ? this.sourceEpochs.get(parent) : undefined;
  }

  isParentOperationPermitted(parent: ServerWebSocket<RuntimeSocketData>, action: string) {
    return (
      !this.terminalSockets.has(parent) ||
      (action === "source-drain" &&
        this.failedSourceParents.has(parent) &&
        this.sourceParents.has(parent))
    );
  }

  use(attemptID: string) {
    if (!this.connected(attemptID) || this.idleClaims.has(attemptID)) return false;
    this.touch(attemptID);
    return true;
  }

  claimIdle(
    attemptID: string,
    idleMS: number,
    quietMS: number,
    attended: boolean,
    hasActiveWork: boolean,
  ) {
    const activity = this.#activity.get(attemptID);
    const graceMS = attended ? idleMS : Math.min(quietMS, idleMS);
    if (
      // Native PTY Resume currently fails to reopen /dev/tty. Do not admit
      // automatic Pause of an open terminal, including a detached idle shell.
      activity?.terminals !== 0 ||
      this.commandCounts.get(attemptID) !== 0 ||
      activity?.busyTerminals !== 0 ||
      this.#now() - activity.terminalObservedAt > 15_000 ||
      this.#now() - activity.lastUse < graceMS ||
      !this.connected(attemptID) ||
      this.idleClaims.has(attemptID) ||
      hasActiveWork
    )
      return false;
    this.idleClaims.add(attemptID);
    return true;
  }

  releaseIdle(attemptID: string) {
    this.idleClaims.delete(attemptID);
    this.touch(attemptID);
  }

  touch(attemptID: string) {
    const activity = this.#activity.get(attemptID);
    if (activity) activity.lastUse = this.#now();
    else
      this.#activity.set(attemptID, {
        lastUse: this.#now(),
        terminals: null,
        busyTerminals: null,
        terminalObservedAt: this.#now(),
        revision: -1,
      });
  }

  observeTerminals(attemptID: string, message: ConnectorMessage) {
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
      activity.terminalObservedAt = this.#now();
      return;
    }
    activity.terminals = terminalCount;
    activity.busyTerminals = terminalBusy;
    activity.terminalObservedAt = this.#now();
    activity.revision = terminalRevision;
    activity.lastUse = this.#now();
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

  requireBrowserAppChannel(attemptID: string, channel: string) {
    const child = this.children.get(attemptID);
    if (
      !child ||
      !this.readyChildren.has(child) ||
      this.terminalSockets.has(child) ||
      !this.hasAppChannel(attemptID, channel)
    )
      throw new Error("Browser request requires a current declared App channel");
  }

  #process(attemptID: string, name: string) {
    let processes = this.#processes.get(attemptID);
    if (!processes) {
      processes = new Map();
      this.#processes.set(attemptID, processes);
    }
    let process = processes.get(name);
    if (!process) {
      // SSE snapshots hold at most 16 entries. Reserve one for Parent setup;
      // Child process names must not grow the in-memory map without a bound.
      if (name !== "setup" && processes.size - Number(processes.has("setup")) >= 15) return;
      process = { name, state: "starting", output: "" };
      processes.set(name, process);
    }
    return process;
  }
}
