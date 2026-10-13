import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { injectable } from "@theia/core/shared/inversify";
import { factoryRuntimeContext, factoryWorkspaceRuntimePath } from "./factory-runtime-context";
import { factoryWriteContext } from "./factory-write-context";

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
  onDidInitializeLayout() {
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
      factoryWriteContext.select(this.#workspaceID);
      this.#commandID = crypto.randomUUID();
      this.#bar.hidden = true;
      void this.#read();
    });
    this.#timer = setInterval(() => {
      if (!document.hidden) void this.#read();
    }, 2_000);
  }
  async #read(takeOver = false) {
    const workspaceID = this.#workspaceID;
    if (!workspaceID || this.#busy) return;
    this.#busy = true;
    this.#action.disabled = true;
    if (takeOver) this.#copy.textContent = "Stopping previous work before editing…";
    try {
      const endpoint = factoryWorkspaceRuntimePath(workspaceID).replace(/\/runtime$/, "/writer");
      const response = await fetch(endpoint, {
        method: takeOver ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        ...(takeOver
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ commandID: this.#commandID }),
            }
          : {}),
      });
      const value: unknown = await response.json();
      if (this.#workspaceID !== workspaceID) return;
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
      factoryWriteContext.confirm(workspaceID, value.canWrite);
      if (
        "commandID" in value &&
        typeof value.commandID === "string" &&
        /^[0-9a-f-]{36}$/.test(value.commandID)
      )
        this.#commandID = value.commandID;
      this.#copy.textContent =
        value.state === "handoff"
          ? "Editing takeover is pending. Existing files are preserved."
          : value.state === "human"
            ? "Another developer is editing. Files remain available to read."
            : "Observation mode. The Agent owns this implementation.";
      this.#action.hidden =
        value.state === "human" || (value.state === "handoff" && "yours" in value && !value.yours);
      this.#action.textContent =
        value.state === "handoff" ? "Continue takeover" : "Take over editing";
      if (takeOver && value.canWrite) factoryRuntimeContext.select(workspaceID);
    } catch (cause) {
      if (this.#workspaceID === workspaceID) {
        factoryWriteContext.confirm(workspaceID, false);
        this.#bar.hidden = false;
        this.#copy.textContent =
          cause instanceof Error ? cause.message : "Editing authority is unavailable.";
      }
    } finally {
      this.#busy = false;
      this.#action.disabled = false;
    }
  }
  onStop() {
    this.#subscription?.dispose();
    if (this.#timer) clearInterval(this.#timer);
    this.#bar.remove();
  }
}
