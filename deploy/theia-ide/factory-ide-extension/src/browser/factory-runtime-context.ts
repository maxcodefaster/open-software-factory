import { authorizedFactoryOrigin } from "./factory-parent-context";

export interface FactoryRuntimeReference {
  readonly workspaceID: string;
  readonly attemptID: string;
}
export interface FactoryRuntimeState {
  readonly workspaceID: string;
  readonly attemptID: string | null;
  readonly kind?: string;
  readonly state: string;
  readonly failure: string | null;
}
const identity = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const preparingStates = new Set([
  "loading",
  "create-intended",
  "starting",
  "reconnecting",
  "pausing",
  "resuming",
  "stop-intended",
  "stopping",
]);

export function factoryWorkspaceRuntimePath(workspaceID: string, href = window.location.href) {
  if (!identity.test(workspaceID)) throw new Error("Workspace identity is invalid");
  return `${new URL("./", href).pathname}__factory/workspaces/${workspaceID}/runtime`;
}
export function factoryRuntimePath(
  runtime: FactoryRuntimeReference,
  resource: string,
  href = window.location.href,
) {
  if (!identity.test(runtime.attemptID)) throw new Error("Runtime Attempt identity is invalid");
  return `${factoryWorkspaceRuntimePath(runtime.workspaceID, href)}/${runtime.attemptID}/${resource}`;
}
export function factoryProcessActionPath(
  runtime: FactoryRuntimeReference,
  process: string,
  action: "start" | "stop" | "restart",
  href = window.location.href,
) {
  return factoryRuntimePath(runtime, `processes/${encodeURIComponent(process)}/${action}`, href);
}
export function factoryTerminalPath(
  runtime: FactoryRuntimeReference,
  sessionID: string,
  href = window.location.href,
) {
  return factoryRuntimePath(runtime, `terminal/${encodeURIComponent(sessionID)}`, href);
}
export function factoryTerminalClosePath(
  runtime: FactoryRuntimeReference,
  sessionID: string,
  href = window.location.href,
) {
  return factoryRuntimePath(runtime, `terminals/${encodeURIComponent(sessionID)}`, href);
}
export function readyRuntime(
  value: FactoryRuntimeState | undefined,
): FactoryRuntimeReference | undefined {
  return value?.state === "ready" && value.attemptID
    ? { workspaceID: value.workspaceID, attemptID: value.attemptID }
    : undefined;
}
// Native restore failures can carry whole log excerpts and host paths. Keep a readable bound.
function boundedFailure(failure: string, limit = 240) {
  const text = failure.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit - 40))}…`;
}

export function runtimeSettled(value: FactoryRuntimeState | undefined) {
  return (
    !value ||
    !preparingStates.has(value.state) ||
    (["pausing", "resuming"].includes(value.state) && Boolean(value.failure))
  );
}

export function runtimePreparationCopy(value: FactoryRuntimeState | undefined) {
  if (!value) return "Select a Workspace to use its environment.";
  if (value.state === "resuming" && value.failure)
    return "Could not confirm environment resume. Your files are safe — check status before retrying.";
  if (value.failure) return boundedFailure(value.failure);
  if (["loading", "create-intended", "starting", "reconnecting", "resuming"].includes(value.state))
    return "Starting environment… Your open files stay intact.";
  if (value.state === "pausing") return "Pausing environment for everyone… Your files are saved.";
  if (value.state === "paused")
    return "Environment paused. Resume to use terminals or previews — opening files resumes it automatically.";
  if (value.state === "cleanup-failed")
    return "Previous environment shutdown is unconfirmed. Start is paused until cleanup completes; your files are safe.";
  if (["stop-intended", "stopping"].includes(value.state))
    return "Stopping environment… Your open files stay intact.";
  return "Environment stopped. Start it when you need a terminal or preview.";
}

export class FactoryRuntimeContext {
  readonly #listeners = new Set<(state: FactoryRuntimeState | undefined) => void>();
  #value: FactoryRuntimeState | undefined;
  #selection = 0;
  #cancel: AbortController | undefined;
  #observing = false;
  #writable = false;
  #lastActivity = -Infinity;
  #preparationFailure: string | undefined;
  #pauseRequestID: string | undefined;
  #pauseFailure: string | undefined;
  constructor(
    private readonly href: () => string = () => window.location.href,
    private readonly fetcher: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response> = (...args) => fetch(...args),
  ) {}
  get value() {
    return this.#value;
  }
  subscribe(listener: (state: FactoryRuntimeState | undefined) => void) {
    this.#listeners.add(listener);
    listener(this.#value);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }
  select(workspaceID: string) {
    const sameWorkspace = workspaceID === this.#value?.workspaceID;
    this.#cancel?.abort();
    this.#cancel = new AbortController();
    const selection = ++this.#selection;
    this.#writable = false;
    this.#lastActivity = -Infinity;
    this.#preparationFailure = undefined;
    if (!sameWorkspace) {
      this.#pauseRequestID = undefined;
      this.#pauseFailure = undefined;
    }
    if (!sameWorkspace || !this.#value || this.#value.state === "loading") {
      this.#set({ workspaceID, attemptID: null, state: "loading", failure: null });
    }
    void this.#read(workspaceID, selection, this.#cancel.signal);
  }
  refresh(runtime: FactoryRuntimeReference) {
    if (
      this.#value?.workspaceID === runtime.workspaceID &&
      this.#value.attemptID === runtime.attemptID
    )
      void this.observe();
  }
  setWritable(workspaceID: string, allowed: boolean) {
    if (workspaceID !== this.#value?.workspaceID) return;
    this.#writable = allowed;
    // Source selection and changes in editing authority never demand compute.
  }
  async use() {
    const current = this.#value;
    if (!current || !this.#writable) return;
    if (current.state !== "ready" || Date.now() - this.#lastActivity < 15_000) return;
    this.#lastActivity = Date.now();
    try {
      const response = await this.fetcher(
        `${factoryWorkspaceRuntimePath(current.workspaceID, this.href())}/activity`,
        { method: "POST", credentials: "same-origin", signal: this.#cancel?.signal ?? null },
      );
      if (response.status === 409 && this.#value?.workspaceID === current.workspaceID) {
        await this.observe();
      }
    } catch {
      // A lost activity report does not authorize a second Start.
    }
  }
  async observe() {
    const current = this.#value;
    const signal = this.#cancel?.signal;
    if (!current || !signal || signal.aborted || this.#observing || !runtimeSettled(current))
      return;
    const selection = this.#selection;
    this.#observing = true;
    try {
      await this.#request(current.workspaceID, selection, signal);
      if (!runtimeSettled(this.#value)) await this.#read(current.workspaceID, selection, signal);
    } catch (cause) {
      this.#fail(current.workspaceID, selection, signal, cause);
    } finally {
      this.#observing = false;
    }
  }
  async prepare() {
    const current = this.#value;
    if (
      !current ||
      this.#pauseRequestID ||
      preparingStates.has(current.state) ||
      ["ready", "unavailable", "cleanup-failed", "pause-uncertain"].includes(current.state)
    )
      return;
    const selection = this.#selection;
    this.#preparationFailure = undefined;
    this.#cancel?.abort();
    this.#cancel = new AbortController();
    const signal = this.#cancel.signal;
    this.#set({
      ...current,
      state: current.state === "paused" ? "resuming" : "starting",
      failure: null,
    });
    try {
      await this.#request(current.workspaceID, selection, signal, true);
      if (!signal.aborted) await this.#read(current.workspaceID, selection, signal);
    } catch (cause) {
      if (!signal.aborted && selection === this.#selection)
        this.#preparationFailure =
          cause instanceof Error ? cause.message : "Workspace preparation is unconfirmed";
      this.#fail(current.workspaceID, selection, signal, cause);
    }
  }
  async pause() {
    const current = this.#value;
    if (
      !current?.attemptID ||
      !this.#writable ||
      !["ready", "pause-uncertain"].includes(current.state)
    )
      return;
    this.#pauseRequestID ??= crypto.randomUUID();
    const requestID = this.#pauseRequestID;
    const selection = this.#selection;
    this.#cancel?.abort();
    this.#cancel = new AbortController();
    const signal = this.#cancel.signal;
    this.#pauseFailure = undefined;
    this.#preparationFailure = undefined;
    this.#set({ ...current, state: "pausing", failure: null });
    try {
      const response = await this.fetcher(
        `${factoryWorkspaceRuntimePath(current.workspaceID, this.href())}/pause`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestID }),
          signal,
        },
      );
      const result: unknown = await response.json();
      if (
        !response.ok ||
        typeof result !== "object" ||
        result === null ||
        !("state" in result) ||
        typeof result.state !== "string" ||
        result.state === "uncertain"
      )
        throw new Error("Pause outcome is unconfirmed. Check Pause before taking another action.");
      if (signal.aborted || selection !== this.#selection) return;
      this.#pauseRequestID = undefined;
      await this.#read(current.workspaceID, selection, signal);
    } catch {
      if (!signal.aborted && selection === this.#selection) {
        this.#pauseFailure = `Pause outcome is unconfirmed. Check Pause to observe request ${requestID}; do not start a replacement.`;
        this.#set({
          ...current,
          state: "pause-uncertain",
          failure: this.#pauseFailure,
        });
      }
    }
  }
  async #read(workspaceID: string, selection: number, signal: AbortSignal) {
    try {
      const deadline = Date.now() + 300_000;
      while (!signal.aborted && selection === this.#selection) {
        await this.#request(workspaceID, selection, signal);
        if (runtimeSettled(this.#value)) return;
        if (Date.now() > deadline)
          throw new Error(
            "Compute status is not yet confirmed. Reopen this Workspace to check its progress.",
          );
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 500);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    } catch (cause) {
      this.#fail(workspaceID, selection, signal, cause);
    }
  }
  async #request(workspaceID: string, selection: number, signal: AbortSignal, prepare = false) {
    const response = await this.fetcher(
      `${factoryWorkspaceRuntimePath(workspaceID, this.href())}${prepare ? "/ensure" : ""}`,
      {
        method: prepare ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal,
      },
    );
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        typeof value === "object" &&
          value !== null &&
          "error" in value &&
          typeof value.error === "string"
          ? value.error
          : "Workspace compute is unavailable",
      );
    if (
      typeof value !== "object" ||
      value === null ||
      !("workspaceID" in value) ||
      value.workspaceID !== workspaceID ||
      !("state" in value) ||
      typeof value.state !== "string" ||
      !("attemptID" in value) ||
      (value.attemptID !== null &&
        (typeof value.attemptID !== "string" || !identity.test(value.attemptID))) ||
      !("failure" in value) ||
      (value.failure !== null && typeof value.failure !== "string")
    )
      throw new Error("Workspace compute context is invalid");
    if (!signal.aborted && selection === this.#selection) {
      const observed = value as FactoryRuntimeState;
      if (observed.state === "paused") {
        this.#pauseRequestID = undefined;
        this.#pauseFailure = undefined;
      }
      // A capacity-wait or unconfirmed /ensure rejection can leave the persisted
      // attempt in "starting" with failure=null. Keep surfacing the rejection
      // until the attempt reaches ready, reports its own failure, or moves on.
      const keepPreparationFailure =
        Boolean(this.#preparationFailure) &&
        !observed.failure &&
        ["stopped", "paused", "create-intended", "starting", "resuming"].includes(observed.state);
      if (!keepPreparationFailure) this.#preparationFailure = undefined;
      this.#set(
        this.#pauseFailure && observed.state === "ready"
          ? { ...observed, state: "pause-uncertain", failure: this.#pauseFailure }
          : keepPreparationFailure && this.#preparationFailure
            ? { ...observed, state: "failed", failure: this.#preparationFailure }
            : observed,
      );
    }
  }
  #fail(workspaceID: string, selection: number, signal: AbortSignal, cause: unknown) {
    if (signal.aborted || selection !== this.#selection) return;
    if (this.#pauseRequestID) {
      this.#pauseFailure ??= `Pause outcome is unconfirmed. Check Pause to observe request ${this.#pauseRequestID}; do not start a replacement.`;
      this.#set({
        workspaceID,
        attemptID: this.#value?.attemptID ?? null,
        state: "pause-uncertain",
        failure: this.#pauseFailure,
      });
    } else
      this.#set({
        workspaceID,
        attemptID: null,
        state: "failed",
        failure: cause instanceof Error ? cause.message : "Workspace compute is unavailable",
      });
  }
  #set(value: FactoryRuntimeState) {
    if (
      this.#value?.workspaceID === value.workspaceID &&
      this.#value.attemptID === value.attemptID &&
      this.#value.state === value.state &&
      this.#value.failure === value.failure
    )
      return;
    this.#value = value;
    for (const listener of this.#listeners) listener(value);
  }
}
export const factoryRuntimeContext = new FactoryRuntimeContext();

export async function openFactoryPreview(
  runtime: FactoryRuntimeReference,
  process: string,
  label: string,
) {
  if (window.parent === window) return;
  const origin = await authorizedFactoryOrigin(window.location.href, document.referrer);
  if (origin)
    window.parent.postMessage(
      { type: "factory:open-development-preview", ...runtime, process, label },
      origin,
    );
}
