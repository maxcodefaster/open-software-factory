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
export function runtimePreparationCopy(value: FactoryRuntimeState | undefined) {
  if (!value) return "Select a Workspace to use its compute.";
  if (value.failure) return value.failure;
  if (["loading", "create-intended", "starting", "reconnecting", "resuming"].includes(value.state))
    return "Preparing Workspace compute. Your source files remain available.";
  if (value.state === "pausing" || value.state === "paused")
    return "Workspace compute is paused. Continue working to resume it.";
  if (["stop-intended", "stopping", "cleanup-failed"].includes(value.state))
    return "Workspace compute is stopping. Your source files remain available.";
  return "Workspace compute starts automatically when you open it for editing.";
}

export class FactoryRuntimeContext {
  readonly #listeners = new Set<(state: FactoryRuntimeState | undefined) => void>();
  #value: FactoryRuntimeState | undefined;
  #selection = 0;
  #cancel: AbortController | undefined;
  #observing = false;
  #writable = false;
  #demanded = false;
  #lastActivity = -Infinity;
  #preparationFailure: string | undefined;
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
  select(workspaceID: string, automatic = false) {
    this.#cancel?.abort();
    this.#cancel = new AbortController();
    const selection = ++this.#selection;
    this.#writable = false;
    this.#demanded = automatic;
    this.#lastActivity = -Infinity;
    this.#preparationFailure = undefined;
    this.#set({ workspaceID, attemptID: null, state: "loading", failure: null });
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
    // A read-only opening is not a deferred request to start compute when
    // someone else's work later stops or releases writing authority.
    if (!allowed) this.#demanded = false;
    this.#prepareDemand();
  }
  async use() {
    const current = this.#value;
    if (!current || !this.#writable) return;
    this.#demanded = true;
    this.#prepareDemand();
    if (current.state !== "ready" || Date.now() - this.#lastActivity < 15_000) return;
    this.#lastActivity = Date.now();
    try {
      const response = await this.fetcher(
        `${factoryWorkspaceRuntimePath(current.workspaceID, this.href())}/activity`,
        { method: "POST", credentials: "same-origin", signal: this.#cancel?.signal ?? null },
      );
      if (response.status === 409 && this.#value?.workspaceID === current.workspaceID) {
        this.#demanded = true;
        await this.observe();
      }
    } catch {
      // A lost activity report does not authorize a second Start.
    } finally {
      if (this.#value?.workspaceID === current.workspaceID && this.#value.state === "ready")
        this.#demanded = false;
    }
  }
  #prepareDemand() {
    const current = this.#value;
    if (!this.#demanded || !current) return;
    if (
      current.state === "ready" ||
      current.state === "failed" ||
      current.state === "unavailable"
    ) {
      this.#demanded = false;
      return;
    }
    if (!this.#writable || this.#preparationFailure) return;
    if (!["stopped", "paused"].includes(current.state)) return;
    this.#demanded = false;
    void this.prepare();
  }
  async observe() {
    const current = this.#value;
    const signal = this.#cancel?.signal;
    if (
      !current ||
      !signal ||
      signal.aborted ||
      this.#observing ||
      preparingStates.has(current.state)
    )
      return;
    const selection = this.#selection;
    this.#observing = true;
    try {
      await this.#request(current.workspaceID, selection, signal);
      if (preparingStates.has(this.#value?.state ?? ""))
        await this.#read(current.workspaceID, selection, signal);
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
      preparingStates.has(current.state) ||
      ["ready", "unavailable", "cleanup-failed"].includes(current.state)
    )
      return;
    const selection = this.#selection;
    this.#preparationFailure = undefined;
    this.#cancel?.abort();
    this.#cancel = new AbortController();
    const signal = this.#cancel.signal;
    this.#set({ ...current, state: "starting", failure: null });
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
  async #read(workspaceID: string, selection: number, signal: AbortSignal) {
    try {
      const deadline = Date.now() + 300_000;
      while (!signal.aborted && selection === this.#selection) {
        await this.#request(workspaceID, selection, signal);
        if (!this.#value || !preparingStates.has(this.#value.state)) return;
        if (Date.now() > deadline)
          throw new Error(
            "Compute is still preparing. Reopen this Workspace to check its progress.",
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
    const value: unknown = await response.json();
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
      this.#set(
        this.#preparationFailure && ["stopped", "paused"].includes(observed.state)
          ? { ...observed, state: "failed", failure: this.#preparationFailure }
          : observed,
      );
    }
  }
  #fail(workspaceID: string, selection: number, signal: AbortSignal, cause: unknown) {
    if (!signal.aborted && selection === this.#selection)
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
    this.#prepareDemand();
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
