import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileNavigatorContribution } from "@theia/navigator/lib/browser/navigator-contribution";
import {
  factoryProcessActionPath,
  factoryRuntimePath,
  openFactoryPreview,
  factoryRuntimeContext,
  readyRuntime,
  runtimePreparationCopy,
  type FactoryRuntimeReference,
} from "./factory-runtime-context";
import { factoryWriteContext } from "./factory-write-context";

type ProcessState = "starting" | "running" | "stopping" | "stopped" | "failed";

type RuntimeProcess = {
  readonly name: string;
  readonly label?: string;
  readonly state: ProcessState;
  readonly output: string;
  readonly startedAt?: string;
  readonly exitCode?: number;
};

type RuntimeProcessResponse = {
  readonly processes: RuntimeProcess[];
};

export const factoryRuntimeWidgetID = "factory-runtime";

function processLabel(process: Pick<RuntimeProcess, "name" | "label">) {
  return (
    process.label ??
    (process.name === "app"
      ? "Primary app"
      : process.name.replace(/^app-/, "").replaceAll("-", " "))
  );
}

function stateLabel(process: RuntimeProcess) {
  if (process.state === "failed" && process.exitCode !== undefined) {
    return `Failed · exit ${process.exitCode}`;
  }
  if (process.state === "stopped" && process.exitCode !== undefined) {
    return `Stopped · exit ${process.exitCode}`;
  }
  if (process.state === "running" && process.startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(process.startedAt)) / 1_000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `Running · ${minutes}m ${seconds % 60}s` : `Running · ${seconds}s`;
  }
  return process.state[0]?.toUpperCase() + process.state.slice(1);
}

function controlButton(label: string, action: () => void, id = label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.control = id;
  button.addEventListener("click", action);
  return button;
}

@injectable()
export class FactoryRuntimeWidget extends BaseWidget {
  readonly #processList = document.createElement("div");
  readonly #main = document.createElement("div");
  readonly #output = document.createElement("pre");
  readonly #clearedOutput = new Map<string, string>();
  #selectedProcess = "app";
  #processes: RuntimeProcess[] = [];
  #events: EventSource | undefined;
  readonly #visibility = () => {
    if (document.hidden) this.#disconnect();
    else this.#connect();
  };
  #busyProcess: string | undefined;
  #follow = true;
  #wrap = true;
  #actionError: string | undefined;
  #runtime: FactoryRuntimeReference | undefined;
  #contextSubscription: { dispose(): void };
  #writeSubscription: { dispose(): void };

  constructor() {
    super();
    this.id = factoryRuntimeWidgetID;
    this.title.label = "Run";
    this.title.caption = "Declared App processes";
    this.title.closable = true;
    this.node.classList.add("factory-runtime-widget");
    this.#processList.className = "factory-runtime-processes";
    this.#processList.setAttribute("aria-label", "Declared App processes");
    this.#main.className = "factory-runtime-main";
    this.#output.className = "factory-runtime-output wrap";
    this.#output.setAttribute("aria-label", "Process output");
    this.#output.setAttribute("aria-live", "off");
    this.#output.textContent = "Connecting to declared processes...";
    this.#main.append(this.#output);
    this.node.append(this.#processList, this.#main);
    this.#contextSubscription = factoryRuntimeContext.subscribe((state) => {
      this.#disconnect();
      this.#runtime = readyRuntime(state);
      this.#processes = [];
      this.#actionError = undefined;
      this.#processList.replaceChildren();
      this.#main.replaceChildren(this.#output);
      this.#output.textContent = runtimePreparationCopy(state);
      if (!this.#runtime && state?.state === "failed") {
        const start = controlButton("Retry compute", () => void factoryRuntimeContext.prepare());
        start.disabled = !factoryWriteContext.allows(state.workspaceID);
        const controls = document.createElement("div");
        controls.className = "factory-compute-status";
        controls.append(start);
        this.#main.prepend(controls);
      }
      this.#connect();
    });
    this.#writeSubscription = factoryWriteContext.subscribe(() => {
      if (this.#runtime) this.#render();
      const start = this.node.querySelector<HTMLButtonElement>('[data-control="Retry compute"]');
      const workspaceID = factoryRuntimeContext.value?.workspaceID;
      if (start) start.disabled = !workspaceID || !factoryWriteContext.allows(workspaceID);
    });
    document.addEventListener("visibilitychange", this.#visibility);
  }

  override dispose(): void {
    this.#contextSubscription.dispose();
    this.#writeSubscription.dispose();
    document.removeEventListener("visibilitychange", this.#visibility);
    this.#disconnect();
    super.dispose();
  }

  protected override onAfterAttach(message: Message): void {
    super.onAfterAttach(message);
    this.#connect();
  }
  protected override onAfterShow(message: Message): void {
    super.onAfterShow(message);
    this.#connect();
  }
  protected override onBeforeHide(message: Message): void {
    this.#disconnect();
    super.onBeforeHide(message);
  }
  #disconnect() {
    this.#events?.close();
    this.#events = undefined;
  }
  #connect() {
    if (this.#events || !this.isAttached || !this.isVisible || document.hidden) return;
    const runtime = this.#runtime;
    if (!runtime) return;
    const source = new EventSource(factoryRuntimePath(runtime, "processes/events"), {
      withCredentials: true,
    });
    this.#events = source;
    source.addEventListener("snapshot", (event) => {
      if (this.#events !== source || this.#runtime?.attemptID !== runtime.attemptID) return;
      try {
        const value = JSON.parse((event as MessageEvent<string>).data) as RuntimeProcessResponse;
        this.#processes = Array.isArray(value.processes) ? value.processes : [];
        if (!this.#processes.some((process) => process.name === this.#selectedProcess)) {
          this.#selectedProcess = this.#processes[0]?.name ?? "app";
        }
        this.#render();
      } catch {
        this.#output.textContent = "Process events are unavailable.";
      }
    });
    source.addEventListener("error", () => {
      if (this.#events !== source) return;
      this.#disconnect();
      this.#output.textContent = "Declared processes are reconnecting...";
      factoryRuntimeContext.refresh(runtime);
    });
  }

  #render() {
    if (!this.#runtime) return;
    const focused = this.node.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    const control = focused?.dataset.control;
    const process = focused?.dataset.process;
    this.#renderProcessList();
    this.#renderMain();
    if (control)
      this.node.querySelector<HTMLElement>(`[data-control="${CSS.escape(control)}"]`)?.focus();
    else if (process)
      this.node
        .querySelector<HTMLButtonElement>(`[data-process="${CSS.escape(process)}"]`)
        ?.focus();
  }

  #renderProcessList() {
    this.#processList.replaceChildren();
    for (const process of this.#processes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "factory-runtime-process";
      button.dataset.process = process.name;
      button.classList.toggle("active", process.name === this.#selectedProcess);
      button.setAttribute("aria-pressed", String(process.name === this.#selectedProcess));
      const dot = document.createElement("span");
      dot.className = `factory-runtime-state ${process.state}`;
      const copy = document.createElement("span");
      const label = document.createElement("strong");
      label.textContent = processLabel(process);
      const state = document.createElement("small");
      state.textContent = stateLabel(process);
      copy.append(label, state);
      button.append(dot, copy);
      button.addEventListener("click", () => {
        this.#selectedProcess = process.name;
        this.#render();
      });
      this.#processList.append(button);
    }
  }

  #renderMain() {
    const optionsOpen =
      this.#main.querySelector<HTMLDetailsElement>(".factory-runtime-output-options")?.open ??
      false;
    const selected =
      this.#processes.find((process) => process.name === this.#selectedProcess) ??
      this.#processes[0];
    const header = document.createElement("div");
    header.className = "factory-runtime-toolbar";
    const processControls = document.createElement("div");
    const outputControls = document.createElement("div");
    if (selected) {
      const canStart = selected.state === "stopped" || selected.state === "failed";
      const lifecycle = controlButton(
        canStart ? "Start" : "Stop",
        () => void this.#runAction(selected, canStart ? "start" : "stop"),
        "process-lifecycle",
      );
      lifecycle.className = "factory-runtime-primary";
      const canWrite = !!this.#runtime && factoryWriteContext.allows(this.#runtime.workspaceID);
      lifecycle.disabled =
        !canWrite || this.#busyProcess === selected.name || selected.state === "stopping";
      lifecycle.title = canWrite
        ? `${canStart ? "Start" : "Stop"} ${processLabel(selected)}`
        : "Observation mode. Request editing to control processes.";
      lifecycle.setAttribute("aria-busy", String(this.#busyProcess === selected.name));
      const restart = controlButton("Restart", () => void this.#runAction(selected, "restart"));
      restart.disabled =
        !canWrite ||
        this.#busyProcess === selected.name ||
        selected.state === "starting" ||
        selected.state === "stopping";
      restart.title = canWrite
        ? `Restart ${processLabel(selected)}`
        : "Observation mode. Request editing to control processes.";
      const runtime = this.#runtime;
      const preview = controlButton("Preview", () => {
        if (runtime) void openFactoryPreview(runtime, selected.name, processLabel(selected));
      });
      preview.disabled = selected.state !== "running";
      processControls.append(lifecycle, restart, preview);
    }
    const follow = controlButton(
      this.#follow ? "Following" : "Follow",
      () => {
        this.#follow = !this.#follow;
        this.#render();
      },
      "follow",
    );
    follow.setAttribute("aria-pressed", String(this.#follow));
    const wrap = controlButton(
      this.#wrap ? "Wrap on" : "Wrap off",
      () => {
        this.#wrap = !this.#wrap;
        this.#render();
      },
      "wrap",
    );
    wrap.setAttribute("aria-pressed", String(this.#wrap));
    const clear = controlButton(
      "Clear",
      () => {
        if (selected) this.#clearedOutput.set(selected.name, selected.output);
        this.#render();
      },
      "clear",
    );
    outputControls.append(follow, wrap, clear);
    const outputOptions = document.createElement("details");
    outputOptions.className = "factory-runtime-output-options";
    outputOptions.open = optionsOpen;
    const outputSummary = document.createElement("summary");
    outputSummary.textContent = "Output options";
    outputSummary.dataset.control = "output-options";
    outputOptions.append(outputSummary, outputControls);
    outputOptions.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      outputOptions.open = false;
      outputSummary.focus();
      event.stopPropagation();
    });
    header.append(processControls, outputOptions);

    const wasAtBottom =
      this.#output.scrollHeight - this.#output.scrollTop - this.#output.clientHeight < 8;
    this.#output.classList.toggle("wrap", this.#wrap);
    const output = selected?.output ?? "";
    const cleared = selected ? this.#clearedOutput.get(selected.name) : undefined;
    this.#output.textContent =
      cleared !== undefined && output.startsWith(cleared)
        ? output.slice(cleared.length)
        : output || `${selected ? processLabel(selected) : "Workspace"} has no output yet.`;
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.className = "factory-runtime-error";
    error.textContent = this.#actionError ?? "";
    this.#main.replaceChildren(header, ...(this.#actionError ? [error] : []), this.#output);
    if (this.#follow || wasAtBottom) this.#output.scrollTop = this.#output.scrollHeight;
  }

  async #runAction(process: RuntimeProcess, action: "start" | "stop" | "restart") {
    const runtime = this.#runtime;
    if (!runtime || this.#busyProcess) return;
    const path = factoryProcessActionPath(runtime, process.name, action);
    this.#busyProcess = process.name;
    this.#actionError = undefined;
    this.#render();
    try {
      const response = await fetch(path, { method: "POST", credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Process action returned ${response.status}`);
      }
    } catch (cause) {
      if (this.#runtime?.attemptID === runtime.attemptID)
        this.#actionError = cause instanceof Error ? cause.message : "Process action failed.";
    } finally {
      this.#busyProcess = undefined;
      if (this.#runtime?.attemptID === runtime.attemptID) this.#render();
    }
  }
}

@injectable()
export class FactoryRuntimeContribution extends AbstractViewContribution<FactoryRuntimeWidget> {
  constructor(
    @inject(FileNavigatorContribution)
    private readonly navigator: FileNavigatorContribution,
  ) {
    super({
      widgetId: factoryRuntimeWidgetID,
      widgetName: "Run",
      defaultWidgetOptions: { area: "bottom", rank: 50 },
      toggleCommandId: "factory.run.toggle",
    });
  }

  async initializeLayout(): Promise<void> {
    await this.navigator.openView({ activate: false, reveal: true });
    await this.openView({ activate: false, reveal: true });
  }
}
