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
  #closing = false;

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
      fontSize: 13,
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
      ) {
        window.dispatchEvent(
          new CustomEvent("factory:editing-activity", {
            detail: { workspaceID: this.runtime.workspaceID },
          }),
        );
        this.#socket.send(encoder.encode(data));
      }
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
    if (this.host.hidden === !visible) return;
    this.host.hidden = !visible;
    if (visible) queueMicrotask(() => this.fit.fit());
  }

  focus() {
    this.terminal.focus();
  }

  beginClose() {
    if (this.#disposed || this.#closing) return false;
    this.#closing = true;
    return true;
  }

  cancelClose() {
    this.#closing = false;
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
      // Deleting this session closes its socket before the HTTP result can arrive.
      // That is not a compute disconnect and must not rebuild the active view.
      if (this.#closing) return;
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
  readonly #toolbar = document.createElement("div");
  readonly #tabs = document.createElement("div");
  readonly #add = document.createElement("button");
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
    this.#tabs.setAttribute("aria-label", "Terminal sessions");
    this.#toolbar.className = "factory-terminal-toolbar";
    this.#add.type = "button";
    this.#add.className = "factory-terminal-add";
    this.#add.textContent = "New terminal";
    this.#add.addEventListener("click", () => {
      if (
        !this.#runtime ||
        this.#terminals.length >= 8 ||
        !factoryWriteContext.allows(this.#runtime.workspaceID)
      )
        return;
      const terminal = this.#newTerminal(this.#terminals.length + 1);
      this.#terminals = [...this.#terminals, terminal];
      this.#activeID = terminal.id;
      this.#save();
      this.#render();
      this.#views.get(terminal.id)?.focus();
    });
    this.#toolbar.append(this.#tabs, this.#add);
    this.#panels.className = "factory-terminal-panels";
    this.#status.className = "factory-compute-status";
    this.#status.setAttribute("role", "status");
    this.node.append(this.#toolbar, this.#status, this.#panels);
    this.#contextSubscription = factoryRuntimeContext.subscribe((state) => {
      const runtime = readyRuntime(state);
      if (runtime?.attemptID !== this.#runtime?.attemptID) {
        this.#runtime = runtime;
        this.#terminals = runtime
          ? (this.#catalogue.get(runtime.attemptID) ?? readStoredTerminals(runtime))
          : [];
        let selected: string | null = null;
        try {
          if (runtime) {
            selected = localStorage.getItem(`${terminalStorageKey(runtime)}:active`);
            if (localStorage.getItem(terminalStorageKey(runtime)) !== null)
              this.#initialized.add(runtime.attemptID);
          }
        } catch {
          /* Keep the first retained session if storage is unavailable. */
        }
        this.#activeID =
          this.#terminals.find((terminal) => terminal.id === selected)?.id ??
          this.#terminals[0]?.id;
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
    while (this.#terminals.some((terminal) => terminal.name === `Terminal ${index}`)) index++;
    return { id: crypto.randomUUID().replaceAll("-", ""), name: `Terminal ${index}` };
  }

  #save() {
    if (!this.#runtime) return;
    this.#catalogue.set(this.#runtime.attemptID, this.#terminals);
    try {
      localStorage.setItem(terminalStorageKey(this.#runtime), JSON.stringify(this.#terminals));
      if (this.#activeID)
        localStorage.setItem(`${terminalStorageKey(this.#runtime)}:active`, this.#activeID);
      else localStorage.removeItem(`${terminalStorageKey(this.#runtime)}:active`);
    } catch {
      /* Storage failure must not prevent use of a live terminal. */
    }
  }

  #render() {
    if (!this.#attached) return;
    this.#tabs.replaceChildren();
    this.#status.replaceChildren();
    const workspaceID = factoryRuntimeContext.value?.workspaceID;
    const canWrite = !!workspaceID && factoryWriteContext.allows(workspaceID);
    this.#toolbar.hidden = !this.#runtime || !canWrite;
    this.#add.disabled = !this.#runtime || !canWrite || this.#terminals.length >= 8;
    for (const view of this.#views.values())
      view.show(
        canWrite &&
          this.isVisible &&
          view.runtime.attemptID === this.#runtime?.attemptID &&
          view.id === this.#activeID,
      );
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
    this.#add.disabled = this.#terminals.length >= 8;
    if (this.#terminals.length === 0) {
      this.#status.hidden = false;
      const copy = document.createElement("p");
      copy.textContent = "No open terminals. Choose New terminal to start a session.";
      this.#status.append(copy);
    }
    for (const terminal of this.#terminals) {
      let view = this.#views.get(terminal.id);
      if (!view) {
        view = new TerminalView(terminal.id, this.#runtime, getComputedStyle(this.node));
        this.#views.set(terminal.id, view);
        this.#panels.append(view.host);
      }
      view.show(terminal.id === this.#activeID);
      view.host.id = `factory-terminal-panel-${terminal.id}`;
      view.host.setAttribute("role", "tabpanel");
      view.host.setAttribute("aria-labelledby", `factory-terminal-tab-${terminal.id}`);
      const tab = document.createElement("div");
      tab.className = "factory-terminal-tab";
      tab.classList.toggle("active", terminal.id === this.#activeID);
      tab.setAttribute("role", "presentation");
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = terminal.name;
      select.id = `factory-terminal-tab-${terminal.id}`;
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(terminal.id === this.#activeID));
      select.setAttribute("aria-controls", view.host.id);
      select.tabIndex = terminal.id === this.#activeID ? 0 : -1;
      select.title = `${terminal.name}. Double-click or press F2 to rename.`;
      select.addEventListener("click", () => {
        this.#select(terminal.id);
        this.#views.get(terminal.id)?.focus();
      });
      select.addEventListener("dblclick", () => this.#rename(terminal, select));
      select.addEventListener("keydown", (event) => {
        if (event.key === "F2") {
          event.preventDefault();
          this.#rename(terminal, select);
          return;
        }
        const index = this.#terminals.findIndex((item) => item.id === terminal.id);
        const next =
          event.key === "ArrowRight"
            ? this.#terminals[(index + 1) % this.#terminals.length]
            : event.key === "ArrowLeft"
              ? this.#terminals[(index - 1 + this.#terminals.length) % this.#terminals.length]
              : event.key === "Home"
                ? this.#terminals[0]
                : event.key === "End"
                  ? this.#terminals.at(-1)
                  : undefined;
        if (!next) return;
        event.preventDefault();
        this.#select(next.id);
        this.#focusTab();
      });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "factory-terminal-close";
      close.setAttribute("aria-label", `Close ${terminal.name}`);
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "m7 7 10 10M17 7 7 17");
      icon.append(path);
      close.append(icon);
      close.addEventListener("click", () => {
        if (close.getAttribute("aria-busy") === "true") return;
        close.setAttribute("aria-busy", "true");
        void this.#close(terminal.id).finally(() => {
          close.removeAttribute("aria-busy");
        });
      });
      tab.append(select, close);
      this.#tabs.append(tab);
    }
  }

  #select(id: string) {
    this.#activeID = id;
    this.#save();
    for (const view of this.#views.values())
      view.show(view.runtime.attemptID === this.#runtime?.attemptID && view.id === id);
    for (const tab of this.#tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      const active = tab.id === `factory-terminal-tab-${id}`;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.parentElement?.classList.toggle("active", active);
    }
  }

  #focusTab() {
    const tab = this.#tabs.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    tab?.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  #rename(terminal: StoredTerminal, button: HTMLButtonElement) {
    const input = document.createElement("input");
    input.value = terminal.name;
    input.setAttribute("aria-label", "Terminal name");
    let finished = false;
    const commit = (restoreFocus: boolean) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim().slice(0, 32) || terminal.name;
      this.#terminals = this.#terminals.map((candidate) =>
        candidate.id === terminal.id ? { ...candidate, name } : candidate,
      );
      this.#save();
      this.#render();
      if (restoreFocus)
        requestAnimationFrame(() => {
          if (!this.isDisposed && this.isVisible) this.#focusTab();
        });
    };
    input.addEventListener("blur", () => commit(false), { once: true });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") input.value = terminal.name;
      commit(true);
    });
    button.replaceWith(input);
    input.select();
  }

  async #close(id: string) {
    const view = this.#views.get(id);
    const runtime = view?.runtime;
    if (!view || !runtime || !view.beginClose()) return;
    const path = factoryTerminalClosePath(runtime, id);
    const returnFocus = this.node.contains(document.activeElement);
    try {
      if (!path) throw new Error("Terminal context is unavailable");
      const response = await fetch(path, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Terminal could not be closed");
    } catch {
      view.cancelClose();
      this.#views
        .get(id)
        ?.terminal.write(
          "\r\nTerminal close failed. Closure was not confirmed; retry closing this session.\r\n",
        );
      return;
    }
    this.#views.get(id)?.dispose();
    this.#views.delete(id);
    const original = this.#catalogue.get(runtime.attemptID) ?? readStoredTerminals(runtime);
    const closingIndex = original.findIndex((terminal) => terminal.id === id);
    const retained = original.filter((terminal) => terminal.id !== id);
    this.#catalogue.set(runtime.attemptID, retained);
    try {
      localStorage.setItem(terminalStorageKey(runtime), JSON.stringify(retained));
    } catch {
      /* The live session catalogue is still retained in memory. */
    }
    if (this.#runtime?.attemptID !== runtime.attemptID) return;
    this.#terminals = retained;
    if (this.#activeID === id) {
      this.#activeID =
        this.#terminals[Math.min(closingIndex, this.#terminals.length - 1)]?.id ??
        this.#terminals[0]?.id;
    }
    const focus = returnFocus && this.node.contains(document.activeElement);
    this.#save();
    this.#render();
    if (focus) {
      const active = this.#views.get(this.#activeID ?? "");
      if (active) active.focus();
      else this.#add.focus({ preventScroll: true });
    }
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
