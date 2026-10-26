import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { inject, injectable } from "@theia/core/shared/inversify";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import {
  factoryRuntimeContext,
  readyRuntime,
  runtimePreparationCopy,
  type FactoryRuntimeState,
} from "./factory-runtime-context";
import { factoryWriteContext } from "./factory-write-context";
import { workspaceScheme } from "./factory-workspace-files";
import { FactoryGitClient, factoryGitStatus, type FactoryGitStatus } from "./factory-git-client";

export const factoryGitWidgetID = "factory-git";

@injectable()
export class FactoryGitWidget extends BaseWidget {
  readonly #client = new FactoryGitClient();
  #runtime: FactoryRuntimeState | undefined;
  #status: FactoryGitStatus | undefined;
  #message = "";
  #selected: string | undefined;
  #diff = "";
  #error = "";
  #busy = false;
  #serial = 0;
  readonly #runtimeSubscription: { dispose(): void };
  readonly #writerSubscription: { dispose(): void };

  constructor(@inject(EditorManager) private readonly editors: EditorManager) {
    super();
    this.id = factoryGitWidgetID;
    this.title.label = "Git";
    this.title.caption = "Git in your personal Workspace";
    this.title.closable = true;
    this.node.classList.add("factory-git-widget");
    this.#runtimeSubscription = factoryRuntimeContext.subscribe((state) => {
      if (state?.workspaceID !== this.#runtime?.workspaceID) {
        this.#serial++;
        this.#status = undefined;
        this.#selected = undefined;
        this.#diff = "";
        this.#error = "";
        this.#message = "";
        this.#busy = false;
      }
      this.#runtime = state;
      this.#render();
      if (!this.#status && this.isVisible && state?.state === "ready") void this.#read();
    });
    this.#writerSubscription = factoryWriteContext.subscribe(() => this.#render());
  }

  override dispose() {
    this.#serial++;
    this.#runtimeSubscription.dispose();
    this.#writerSubscription.dispose();
    super.dispose();
  }

  protected override onAfterShow(message: Message) {
    super.onAfterShow(message);
    if (!this.#status) void this.#read();
  }

  #button(label: string, action: () => void, disabled: boolean) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    button.dataset.control = label;
    button.addEventListener("click", action);
    return button;
  }

  #render() {
    const focused = this.node.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.control
      : undefined;
    const runtime = readyRuntime(this.#runtime);
    this.node.setAttribute("aria-busy", String(this.#busy));
    if (!runtime || this.#runtime?.kind === "ticket") {
      const copy = document.createElement("p");
      copy.className = "factory-git-notice";
      copy.textContent =
        this.#runtime?.kind === "ticket"
          ? "Ticket commits and Delivery stay in Factory's reviewed workflow. Select your personal Workspace to use Git here."
          : runtimePreparationCopy(this.#runtime);
      this.node.replaceChildren(copy);
      return;
    }
    const disabled = this.#busy || !factoryWriteContext.allows(runtime.workspaceID);
    const header = document.createElement("div");
    header.className = "factory-runtime-toolbar";
    const identity = document.createElement("span");
    identity.className = "factory-git-identity";
    identity.textContent = this.#status
      ? `${this.#status.branch || "Detached HEAD"} · ${this.#status.head.slice(0, 8)}`
      : "Personal Workspace";
    identity.title = this.#status?.head ?? "";
    const actions = document.createElement("div");
    actions.append(
      this.#button("Refresh", () => void this.#read(), this.#busy),
      this.#button("Fetch", () => void this.#mutate("fetch"), disabled || !this.#status),
      this.#button("Pull", () => void this.#mutate("pull"), disabled || !this.#status),
    );
    header.append(identity, actions);
    const commit = document.createElement("form");
    commit.className = "factory-git-commit";
    const label = document.createElement("label");
    label.htmlFor = "factory-git-message";
    label.textContent = "Commit saved changes";
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.dataset.control = "message";
    input.type = "text";
    input.maxLength = 240;
    input.placeholder = "Commit message";
    input.value = this.#message;
    input.disabled = disabled;
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Commit all";
    submit.dataset.control = "commit";
    const commitDisabled = () => disabled || !this.#status?.files.length || !this.#message.trim();
    submit.disabled = commitDisabled();
    input.addEventListener("input", () => {
      this.#message = input.value;
      submit.disabled = commitDisabled();
    });
    commit.append(label, input, submit);
    commit.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!commitDisabled()) void this.#mutate("commit");
    });
    const body = document.createElement("div");
    body.className = "factory-git-body";
    const files = document.createElement("div");
    files.className = "factory-git-files";
    files.setAttribute("aria-label", "Changed files");
    for (const file of this.#status?.files ?? []) {
      const button = this.#button(
        `${file.status.trim()}  ${file.path}`,
        () => void this.#read(file.path),
        this.#busy,
      );
      button.setAttribute("aria-pressed", String(this.#selected === file.path));
      button.title = file.path;
      files.append(button);
    }
    if (!this.#status?.files.length) {
      const copy = document.createElement("p");
      copy.textContent = this.#status ? "Working tree clean" : "Loading Git status…";
      files.append(copy);
    }
    const diff = document.createElement("pre");
    diff.className = "factory-runtime-output wrap";
    diff.setAttribute("aria-label", "Selected file diff");
    diff.textContent = this.#diff || "Select a changed file to inspect its diff.";
    body.append(files, diff);
    const error = document.createElement("p");
    error.className = "factory-git-notice";
    error.setAttribute("role", "alert");
    error.textContent = this.#error;
    this.node.replaceChildren(header, commit, ...(this.#error ? [error] : []), body);
    if (focused)
      this.node.querySelector<HTMLElement>(`[data-control="${CSS.escape(focused)}"]`)?.focus();
  }

  async #read(path?: string) {
    const runtime = readyRuntime(this.#runtime);
    if (!runtime || this.#runtime?.kind === "ticket" || this.#busy) return;
    const serial = this.#serial;
    this.#busy = true;
    this.#error = "";
    this.#render();
    try {
      const result = await this.#client.request(
        runtime.workspaceID,
        path === undefined ? "status" : "diff",
        path === undefined ? undefined : { path },
      );
      if (serial !== this.#serial) return;
      if (path === undefined) {
        this.#status = factoryGitStatus(result);
        this.#selected = undefined;
        this.#diff = "";
      } else {
        if (
          !result ||
          typeof result !== "object" ||
          !("diff" in result) ||
          typeof result.diff !== "string"
        )
          throw new Error("Git diff is invalid");
        this.#selected = path;
        this.#diff = result.diff || "No tracked changes in this file.";
      }
    } catch (cause) {
      if (serial === this.#serial)
        this.#error = cause instanceof Error ? cause.message : "Git is unavailable";
    } finally {
      if (serial === this.#serial) {
        this.#busy = false;
        this.#render();
      }
    }
  }

  async #mutate(action: "commit" | "fetch" | "pull") {
    const runtime = readyRuntime(this.#runtime);
    if (!runtime || !this.#status || this.#busy || !factoryWriteContext.allows(runtime.workspaceID))
      return;
    if (
      action !== "fetch" &&
      this.editors.all.some(
        (widget) =>
          widget.editor.uri.scheme === workspaceScheme &&
          widget.editor.uri.authority === runtime.workspaceID &&
          widget.saveable.dirty,
      )
    ) {
      this.#error = "Save or discard your unsaved editor buffers before changing Git history.";
      this.#render();
      return;
    }
    const serial = this.#serial;
    this.#busy = true;
    this.#error = "";
    const body = {
      commandID: crypto.randomUUID(),
      expectedHead: this.#status.head,
      message: action === "commit" ? this.#message : "",
    };
    this.#render();
    try {
      const result = await this.#client.request(runtime.workspaceID, action, body);
      if (serial !== this.#serial) return;
      this.#status = factoryGitStatus(result);
      this.#diff = "";
      this.#selected = undefined;
      if (action === "commit") this.#message = "";
    } catch (cause) {
      if (serial === this.#serial)
        this.#error = cause instanceof Error ? cause.message : "Git result is unconfirmed";
    } finally {
      if (serial === this.#serial) {
        this.#busy = false;
        this.#render();
      }
    }
  }
}

@injectable()
export class FactoryGitContribution extends AbstractViewContribution<FactoryGitWidget> {
  constructor() {
    super({
      widgetId: factoryGitWidgetID,
      widgetName: "Git",
      defaultWidgetOptions: { area: "bottom", rank: 55 },
      toggleCommandId: "factory.git.toggle",
    });
  }
  async initializeLayout() {
    await this.openView({ activate: false, reveal: false });
  }
}
