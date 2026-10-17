import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { injectable } from "@theia/core/shared/inversify";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { factoryTerminalTheme } from "./factory-theme";
import { factoryWriteContext } from "./factory-write-context";
import {
  factoryRuntimeContext,
  readyRuntime,
  runtimePreparationCopy,
  type FactoryRuntimeReference,
  factoryTerminalClosePath,
  factoryTerminalPath,
} from "./factory-runtime-context";

export const factoryTerminalWidgetID = "factory-terminal";

type StoredTerminal = {
  readonly id: string;
  readonly name: string;
};

function terminalStorageKey(runtime: FactoryRuntimeReference) {
  return `factory:terminals:${runtime.attemptID}`;
}

function readStoredTerminals(runtime: FactoryRuntimeReference): StoredTerminal[] {
  try {
    const value = JSON.parse(localStorage.getItem(terminalStorageKey(runtime)) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is StoredTerminal =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as StoredTerminal).id === "string" &&
          /^[a-zA-Z0-9_-]{1,64}$/.test((item as StoredTerminal).id) &&
          typeof (item as StoredTerminal).name === "string",
      )
      .slice(0, 8);
  } catch {
    return [];
  }
}

class TerminalView {
  readonly host = document.createElement("div");
  readonly terminal: Terminal;
  readonly fit = new FitAddon();
  #socket: WebSocket | undefined;
  #resizeObserver: ResizeObserver;
  #inputDisposable: { dispose(): void };
  #resizeDisposable: { dispose(): void };
  #reconnectTimer: number | undefined;
  #disposed = false;

  constructor(
    readonly id: string,
    readonly runtime: FactoryRuntimeReference,
    styles: CSSStyleDeclaration,
  ) {
    this.host.className = "factory-terminal-host";
    this.host.hidden = true;
    this.terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: styles.getPropertyValue("--theia-code-font-family").trim(),
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 2_000,
      theme: factoryTerminalTheme,
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.host);
    this.terminal.write("Connecting to the workspace terminal...\r\n");
    const encoder = new TextEncoder();
    this.#inputDisposable = this.terminal.onData((data) => {
      if (
        this.host.dataset.connectionState === "connected" &&
        this.#socket?.readyState === WebSocket.OPEN
      )
        this.#socket.send(encoder.encode(data));
    });
    this.#resizeDisposable = this.terminal.onResize(({ cols, rows }) => {
      if (
        this.host.dataset.connectionState === "connected" &&
        this.#socket?.readyState === WebSocket.OPEN
      ) {
        this.#socket.send(JSON.stringify({ type: "resize", columns: cols, rows }));
      }
    });
    this.#resizeObserver = new ResizeObserver(() => {
      if (!this.host.hidden) this.fit.fit();
    });
    this.#resizeObserver.observe(this.host);
    this.#connect();
  }

  show(visible: boolean) {
    this.host.hidden = !visible;
    if (visible) queueMicrotask(() => this.fit.fit());
  }

  focus() {
    this.terminal.focus();
  }

  dispose() {
    this.#disposed = true;
    if (this.#reconnectTimer !== undefined) window.clearTimeout(this.#reconnectTimer);
    this.#inputDisposable.dispose();
    this.#resizeDisposable.dispose();
    this.#resizeObserver.disconnect();
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) {
      this.#socket.close(1000, "Terminal detached");
    }
    this.#socket = undefined;
    this.terminal.dispose();
    this.host.remove();
  }

  #connect() {
    const path = factoryTerminalPath(this.runtime, this.id);
    if (!path || this.#disposed) return;
    this.host.dataset.connectionState = "connecting";
    this.host.setAttribute("aria-busy", "true");
    this.terminal.options.disableStdin = true;
    const socket = new WebSocket(
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${path}`,
    );
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.#socket !== socket || this.#disposed) return;
      // Clear connection copy before any PTY output; the ACK alone enables input.
      this.terminal.reset();
      if (!this.host.hidden) this.fit.fit();
      socket.send(
        JSON.stringify({
          type: "resize",
          columns: Math.max(2, this.terminal.cols),
          rows: Math.max(1, this.terminal.rows),
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket || this.#disposed) return;
      if (event.data === '{"type":"terminal-ready"}') {
        if (this.host.dataset.connectionState === "connected") return;
        this.host.dataset.connectionState = "connected";
        this.host.setAttribute("aria-busy", "false");
        this.terminal.options.disableStdin = false;
        if (!this.host.hidden) this.fit.fit();
      } else if (typeof event.data === "string") this.terminal.write(event.data);
      else this.terminal.write(new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket || this.#disposed) return;
      this.host.dataset.connectionState = "disconnected";
      this.host.setAttribute("aria-busy", "true");
      this.terminal.options.disableStdin = true;
      if ([1000, 1008, 1012].includes(event.code)) {
        this.terminal.write(
          "\r\nThis Runtime Attempt is no longer connected. Select Terminal to check compute.\r\n",
        );
        factoryRuntimeContext.refresh(this.runtime);
        return;
      }
      if (this.#disposed || event.code === 1000) return;
      this.terminal.write("\r\nReconnecting to terminal...\r\n");
      this.#reconnectTimer = window.setTimeout(() => this.#connect(), 1_000);
    });
    this.#socket = socket;
  }
}

@injectable()
export class FactoryTerminalWidget extends BaseWidget {
  readonly #tabs = document.createElement("div");
  readonly #panels = document.createElement("div");
  readonly #views = new Map<string, TerminalView>();
  readonly #catalogue = new Map<string, StoredTerminal[]>();
  readonly #initialized = new Set<string>();
  readonly #status = document.createElement("div");
  readonly #contextSubscription: { dispose(): void };
  readonly #writeSubscription: { dispose(): void };
  #runtime: FactoryRuntimeReference | undefined;
  #terminals: StoredTerminal[] = [];
  #activeID: string | undefined;
  #attached = false;

  constructor() {
    super();
    this.id = factoryTerminalWidgetID;
    this.title.label = "Terminal";
    this.title.caption = "Workspace terminals";
    this.title.closable = true;
    this.node.classList.add("factory-terminal-widget");
    this.node.setAttribute("role", "region");
    this.node.setAttribute("aria-label", "Workspace terminals");
    this.#tabs.className = "factory-terminal-tabs";
    this.#tabs.setAttribute("role", "tablist");
    this.#panels.className = "factory-terminal-panels";
    this.#status.className = "factory-compute-status";
    this.node.append(this.#tabs, this.#status, this.#panels);
    this.#contextSubscription = factoryRuntimeContext.subscribe((state) => {
      const runtime = readyRuntime(state);
      if (runtime?.attemptID !== this.#runtime?.attemptID) {
        this.#runtime = runtime;
        this.#terminals = runtime
          ? (this.#catalogue.get(runtime.attemptID) ?? readStoredTerminals(runtime))
          : [];
        this.#activeID = this.#terminals[0]?.id;
      }
      this.#render();
    });
    this.#writeSubscription = factoryWriteContext.subscribe(() => {
      // Detach, never Close, terminals when writing authority changes.
      for (const [id, view] of this.#views) {
        if (!factoryWriteContext.allows(view.runtime.workspaceID)) {
          view.dispose();
          this.#views.delete(id);
        }
      }
      this.#render();
    });
  }

  protected override onAfterAttach(message: Message): void {
    super.onAfterAttach(message);
    this.#attached = true;
    this.#render();
  }

  protected override onAfterShow(message: Message): void {
    super.onAfterShow(message);
    this.#render();
    this.#views.get(this.#activeID ?? "")?.show(true);
  }

  protected override onActivateRequest(message: Message): void {
    super.onActivateRequest(message);
    this.#views.get(this.#activeID ?? "")?.focus();
  }

  override dispose(): void {
    this.#contextSubscription.dispose();
    this.#writeSubscription.dispose();
    for (const view of this.#views.values()) view.dispose();
    this.#views.clear();
    super.dispose();
  }

  #newTerminal(index: number): StoredTerminal {
    return { id: crypto.randomUUID().replaceAll("-", ""), name: `Terminal ${index}` };
  }

  #save() {
    if (!this.#runtime) return;
    this.#catalogue.set(this.#runtime.attemptID, this.#terminals);
    localStorage.setItem(terminalStorageKey(this.#runtime), JSON.stringify(this.#terminals));
  }

  #render() {
    if (!this.#attached) return;
    this.#tabs.replaceChildren();
    for (const view of this.#views.values()) view.show(false);
    this.#status.replaceChildren();
    const workspaceID = factoryRuntimeContext.value?.workspaceID;
    const canWrite = !!workspaceID && factoryWriteContext.allows(workspaceID);
    this.#status.hidden = Boolean(this.#runtime) && canWrite;
    if (!canWrite && workspaceID) {
      const copy = document.createElement("p");
      copy.textContent = "Observation mode. Take over editing before opening a terminal.";
      this.#status.append(copy);
      return;
    }
    if (!this.#runtime) {
      const state = factoryRuntimeContext.value;
      const copy = document.createElement("p");
      copy.textContent = runtimePreparationCopy(state);
      this.#status.append(copy);
      if (state && ["stopped", "failed"].includes(state.state)) {
        const start = document.createElement("button");
        start.type = "button";
        start.textContent = "Start compute";
        start.addEventListener("click", () => void factoryRuntimeContext.prepare());
        this.#status.append(start);
      }
      return;
    }
    if (!this.isVisible) return;
    if (this.#terminals.length === 0 && !this.#initialized.has(this.#runtime.attemptID)) {
      this.#terminals = [this.#newTerminal(1)];
      this.#activeID = this.#terminals[0]?.id;
      this.#save();
    }
    this.#initialized.add(this.#runtime.attemptID);
    for (const terminal of this.#terminals) {
      let view = this.#views.get(terminal.id);
      if (!view) {
        view = new TerminalView(terminal.id, this.#runtime, getComputedStyle(this.node));
        this.#views.set(terminal.id, view);
        this.#panels.append(view.host);
      }
      view.show(terminal.id === this.#activeID);
      const tab = document.createElement("div");
      tab.className = "factory-terminal-tab";
      tab.classList.toggle("active", terminal.id === this.#activeID);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(terminal.id === this.#activeID));
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = terminal.name;
      select.addEventListener("click", () => {
        this.#activeID = terminal.id;
        this.#render();
        this.#views.get(terminal.id)?.focus();
      });
      select.addEventListener("dblclick", () => this.#rename(terminal, select));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "factory-terminal-close";
      close.setAttribute("aria-label", `Close ${terminal.name}`);
      close.textContent = "×";
      close.addEventListener("click", () => void this.#close(terminal.id));
      tab.append(select, close);
      this.#tabs.append(tab);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "factory-terminal-add";
    add.setAttribute("aria-label", "New terminal");
    add.textContent = "+";
    add.disabled = this.#terminals.length >= 8;
    add.addEventListener("click", () => {
      const terminal = this.#newTerminal(this.#terminals.length + 1);
      this.#terminals = [...this.#terminals, terminal];
      this.#activeID = terminal.id;
      this.#save();
      this.#render();
    });
    this.#tabs.append(add);
  }

  #rename(terminal: StoredTerminal, button: HTMLButtonElement) {
    const input = document.createElement("input");
    input.value = terminal.name;
    input.setAttribute("aria-label", "Terminal name");
    const commit = () => {
      const name = input.value.trim().slice(0, 32) || terminal.name;
      this.#terminals = this.#terminals.map((candidate) =>
        candidate.id === terminal.id ? { ...candidate, name } : candidate,
      );
      this.#save();
      this.#render();
    };
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        input.value = terminal.name;
        input.blur();
      }
    });
    button.replaceWith(input);
    input.select();
  }

  async #close(id: string) {
    const view = this.#views.get(id);
    const runtime = view?.runtime;
    if (!runtime) return;
    const path = factoryTerminalClosePath(runtime, id);
    try {
      if (!path) throw new Error("Terminal context is unavailable");
      const response = await fetch(path, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Terminal could not be closed");
    } catch {
      this.#views
        .get(id)
        ?.terminal.write(
          "\r\nTerminal close failed. The session is still available; retry closing it.\r\n",
        );
      return;
    }
    this.#views.get(id)?.dispose();
    this.#views.delete(id);
    const original = this.#catalogue.get(runtime.attemptID) ?? readStoredTerminals(runtime);
    const closingIndex = original.findIndex((terminal) => terminal.id === id);
    const retained = original.filter((terminal) => terminal.id !== id);
    this.#catalogue.set(runtime.attemptID, retained);
    localStorage.setItem(terminalStorageKey(runtime), JSON.stringify(retained));
    if (this.#runtime?.attemptID !== runtime.attemptID) return;
    this.#terminals = retained;
    if (this.#activeID === id) {
      this.#activeID =
        this.#terminals[Math.min(closingIndex, this.#terminals.length - 1)]?.id ??
        this.#terminals[0]?.id;
    }
    this.#save();
    this.#render();
  }
}

@injectable()
export class FactoryTerminalContribution extends AbstractViewContribution<FactoryTerminalWidget> {
  constructor() {
    super({
      widgetId: factoryTerminalWidgetID,
      widgetName: "Terminal",
      defaultWidgetOptions: { area: "bottom", rank: 60 },
      toggleCommandId: "factory.terminal.toggle",
    });
  }

  async initializeLayout(): Promise<void> {
    await this.openView({ activate: false });
  }
}
