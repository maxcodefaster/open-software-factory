import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { inject, injectable } from "@theia/core/shared/inversify";
import { StatusBar, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { factoryRuntimeContext, factoryWorkspaceRuntimePath } from "./factory-runtime-context";
import { factoryWriteContext } from "./factory-write-context";
import { factoryWriterLabel } from "./factory-writer-label";
import { FactoryEditingActivity } from "./factory-editing-activity";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import type { EditorWidget } from "@theia/editor/lib/browser/editor-widget";
import { DisposableCollection } from "@theia/core/lib/common/disposable";
import { workspaceScheme } from "./factory-workspace-files";

// One quiet status/Take over action. Server enforcement does not trust this UI.
@injectable()
export class FactoryWriterContribution implements FrontendApplicationContribution {
  readonly #bar = document.createElement("div");
  readonly #copy = document.createElement("span");
  readonly #action = document.createElement("button");
  #workspaceID: string | undefined;
  #commandID: string = crypto.randomUUID();
  #busy = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #subscription: { dispose(): void } | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  readonly #editing = new FactoryEditingActivity(async (workspaceID, epoch, kind, signal) => {
    const response = await fetch(
      factoryWorkspaceRuntimePath(workspaceID).replace(/\/runtime$/, "/writer/activity"),
      {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ epoch, kind }),
      },
    );
    return ![401, 403, 404, 409].includes(response.status);
  });
  #readCancellation = new AbortController();
  #observedEpoch: number | undefined;
  #actionKind: "takeover" | "request" | "idle-takeover" = "takeover";
  #requested = false;
  readonly #editorSubscriptions = new DisposableCollection();
  #observeEditor(widget: EditorWidget) {
    const editor = widget.editor;
    if (editor.uri.scheme !== workspaceScheme) return;
    // Monaco's EditContext input need not emit a DOM input event.
    const subscription = editor.onDocumentContentChanged(() => {
      if (editor.isFocused() && !editor.isReadonly)
        this.#editing.queue(editor.uri.authority, "edit");
    });
    this.#editorSubscriptions.push(subscription);
    this.#editorSubscriptions.push(widget.onDispose(() => subscription.dispose()));
  }
  readonly #terminalInput = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail?.workspaceID === "string")
      this.#editing.queue(event.detail.workspaceID, "edit");
  };
  constructor(
    @inject(StatusBar) private readonly statusBar: StatusBar,
    @inject(EditorManager) private readonly editors: EditorManager,
  ) {}
  onDidInitializeLayout() {
    for (const widget of this.editors.all) this.#observeEditor(widget);
    this.#editorSubscriptions.push(this.editors.onCreated((widget) => this.#observeEditor(widget)));
    window.addEventListener("factory:editing-activity", this.#terminalInput);
    this.#heartbeat = setInterval(() => {
      if (!document.hidden && this.#workspaceID)
        this.#editing.queue(this.#workspaceID, "heartbeat");
    }, 15_000);
    this.#bar.className = "factory-writer-status";
    this.#bar.setAttribute("role", "status");
    this.#action.type = "button";
    this.#action.textContent = "Take over editing";
    this.#action.addEventListener("click", () => void this.#read(true));
    this.#bar.append(this.#copy, this.#action);
    document.body.append(this.#bar);
    this.#subscription = factoryRuntimeContext.subscribe((state) => {
      if (state?.workspaceID === this.#workspaceID) return;
      this.#workspaceID = state?.workspaceID;
      if (this.#workspaceID) this.#editing.confirm(this.#workspaceID, undefined);
      this.#observedEpoch = undefined;
      this.#requested = false;
      this.#actionKind = "takeover";
      this.#readCancellation.abort();
      this.#readCancellation = new AbortController();
      factoryWriteContext.select(this.#workspaceID);
      this.#commandID = crypto.randomUUID();
      this.#bar.hidden = true;
      void this.statusBar.removeElement("factory-writing");
      void this.#read();
    });
    this.#timer = setInterval(() => {
      if (!document.hidden) {
        void this.#read();
        void factoryRuntimeContext.observe();
      }
    }, 2_000);
  }
  async #read(takeOver = false) {
    const workspaceID = this.#workspaceID;
    if (!workspaceID || this.#busy) return;
    const action = this.#actionKind;
    const epoch = this.#observedEpoch;
    if (
      takeOver &&
      action === "idle-takeover" &&
      !window.confirm(
        "Take over editing? This stops the previous developer's commands. Their unsaved editor buffers are not transferred.",
      )
    )
      return;
    const cancellation = this.#readCancellation;
    this.#busy = true;
    this.#action.disabled = true;
    if (takeOver)
      this.#copy.textContent =
        action === "request" ? "Requesting editing…" : "Stopping previous work before editing…";
    try {
      const endpoint = factoryWorkspaceRuntimePath(workspaceID).replace(/\/runtime$/, "/writer");
      const response = await fetch(
        takeOver && action !== "takeover" ? `${endpoint}/${action}` : endpoint,
        {
          method: takeOver ? "POST" : "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([
            cancellation.signal,
            AbortSignal.timeout(takeOver ? 60_000 : 8_000),
          ]),
          ...(takeOver
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  commandID: this.#commandID,
                  epoch,
                }),
              }
            : {}),
        },
      );
      const value: unknown = await response.json();
      if (this.#workspaceID !== workspaceID || cancellation.signal.aborted) return;
      if (!response.ok) {
        const message =
          value && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error
            : "Editing authority is unavailable.";
        throw new Error(message);
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("canWrite" in value) ||
        typeof value.canWrite !== "boolean" ||
        !("state" in value) ||
        typeof value.state !== "string"
      )
        throw new Error("Editing authority is unavailable.");
      this.#bar.hidden = value.canWrite;
      const editingEpoch =
        value.canWrite &&
        "epoch" in value &&
        typeof value.epoch === "number" &&
        Number.isSafeInteger(value.epoch)
          ? value.epoch
          : undefined;
      this.#editing.confirm(workspaceID, editingEpoch);
      factoryWriteContext.confirm(workspaceID, value.canWrite);
      const observed =
        "epoch" in value && typeof value.epoch === "number" ? value.epoch : undefined;
      const idle =
        "presence" in value &&
        value.presence &&
        typeof value.presence === "object" &&
        "idle" in value.presence &&
        value.presence.idle === true;
      const nextAction =
        value.state === "human" && !value.canWrite
          ? idle
            ? "idle-takeover"
            : "request"
          : "takeover";
      if (this.#observedEpoch !== observed || this.#actionKind !== nextAction)
        this.#commandID = crypto.randomUUID();
      this.#observedEpoch = observed;
      this.#actionKind = nextAction;
      this.#requested =
        "requests" in value && Array.isArray(value.requests) && value.requests.length > 0;
      if (
        "commandID" in value &&
        typeof value.commandID === "string" &&
        /^[0-9a-f-]{36}$/.test(value.commandID)
      )
        this.#commandID = value.commandID;
      const label = factoryWriterLabel({
        state: value.state,
        canWrite: value.canWrite,
        ...("actor" in value ? { actor: value.actor } : {}),
        ...("requester" in value ? { requester: value.requester } : {}),
        ...("presence" in value ? { presence: value.presence } : {}),
      });
      this.#copy.textContent = label;
      void this.statusBar.setElement("factory-writing", {
        text: label,
        tooltip: label,
        alignment: StatusBarAlignment.LEFT,
        priority: 97,
      });
      this.#action.hidden =
        value.canWrite ||
        (value.state === "handoff" &&
          (("yours" in value && !value.yours) ||
            ("handoffKind" in value && value.handoffKind === "release")));
      this.#action.textContent =
        value.state === "handoff"
          ? "Continue takeover"
          : nextAction === "request"
            ? this.#requested
              ? "Editing requested"
              : "Request editing"
            : "Take over editing";
      if (takeOver && value.canWrite) factoryRuntimeContext.select(workspaceID);
    } catch (cause) {
      if (this.#workspaceID === workspaceID && !cancellation.signal.aborted) {
        factoryWriteContext.confirm(workspaceID, false);
        this.#bar.hidden = false;
        this.#editing.confirm(workspaceID, undefined);
        this.#copy.textContent =
          cause instanceof Error ? cause.message : "Editing authority is unavailable.";
        void this.statusBar.setElement("factory-writing", {
          text: "Editing status unavailable",
          tooltip: this.#copy.textContent,
          alignment: StatusBarAlignment.LEFT,
          priority: 97,
        });
      }
    } finally {
      this.#busy = false;
      this.#action.disabled = this.#actionKind === "request" && this.#requested;
    }
  }
  onStop() {
    this.#editing.close();
    this.#readCancellation.abort();
    clearInterval(this.#heartbeat);
    this.#editorSubscriptions.dispose();
    window.removeEventListener("factory:editing-activity", this.#terminalInput);
    void this.statusBar.removeElement("factory-writing");
    this.#subscription?.dispose();
    if (this.#timer) clearInterval(this.#timer);
    this.#bar.remove();
  }
}
