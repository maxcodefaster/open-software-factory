import "../../deploy/theia-ide/node_modules/@theia/core/src/browser/style/index.css";
import "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-ide.css";
import { FactoryRuntimeContext } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-runtime-context";
import { observeFactoryRuntimeUse } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-runtime-use";
import { factoryTheme } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-theme";
import { FactoryWriterDialog } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-writer-dialog";

for (const [name, value] of Object.entries(factoryTheme.json.colors))
  document.documentElement.style.setProperty(`--theia-${name.replaceAll(".", "-")}`, value);
const style = document.createElement("style");
style.textContent = `
  :root { --theia-ui-font-size1: 13px; --theia-ui-padding: 4px; }
  body { margin: 0; font: 13px system-ui; color: var(--theia-editor-foreground);
    background: var(--theia-editor-background); }
  main { padding: 20px; }
  h1 { font-size: 16px; }
  footer { position: fixed; inset: auto 0 0; padding: 4px;
    background: var(--theia-statusBar-background); }
  .theia-button { background: var(--theia-button-background); }
  .theia-button.secondary { color: var(--theia-button-secondaryForeground);
    background: var(--theia-button-secondaryBackground); }
`;
document.head.append(style);
const output = document.querySelector("output");
let commands = 0;
const dialog = new FactoryWriterDialog(() => {
  if (output) output.value = String(++commands);
});
dialog.copy.textContent = "Agent working · requested by Local administrator. Observation mode.";
dialog.action.textContent = "Take over editing";
dialog.action.hidden = false;
document.body.append(dialog.element);
document.querySelector("#editing-access")?.addEventListener("click", () => dialog.open());

if (new URL(window.location.href).searchParams.has("compute")) {
  const workspaceID = "22222222-2222-4222-8222-222222222222";
  const attemptID = "33333333-3333-4333-8333-333333333333";
  let state = "ready";
  let starts = 0;
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = "Simulated server state";
  const status = document.createElement("output");
  status.setAttribute("aria-label", "Compute state");
  const count = document.createElement("output");
  count.setAttribute("aria-label", "Start commands");
  count.value = "0";
  const context = new FactoryRuntimeContext(
    () => window.location.href,
    async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/ensure")) {
        count.value = String(++starts);
        state = "ready";
      }
      return Response.json({ workspaceID, attemptID, state, failure: null });
    },
  );
  const start = document.createElement("button");
  start.type = "button";
  start.className = "theia-button";
  start.addEventListener("click", () => void context.prepare());
  context.subscribe((value) => {
    status.value = value?.state ?? "loading";
    start.textContent = value?.state === "paused" ? "Resume compute" : "Start compute";
    start.hidden = !value || !["stopped", "paused"].includes(value.state);
  });
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "theia-button";
  stop.textContent = "Observe external Stop";
  stop.addEventListener("click", () => {
    state = "stopped";
    void context.observe();
  });
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "theia-button";
  pause.textContent = "Observe external Pause";
  pause.addEventListener("click", () => {
    state = "paused";
    void context.observe();
  });
  const grant = document.createElement("button");
  grant.type = "button";
  grant.className = "theia-button";
  grant.textContent = "Observe editing grant";
  grant.addEventListener("click", () => context.setWritable(workspaceID, true));
  const use = document.createElement("button");
  use.type = "button";
  use.className = "theia-button";
  use.textContent = "Continue editing";
  // The actual IDE observes trusted pointer, wheel and keyboard input.
  observeFactoryRuntimeUse(document, () => context.use());
  section.append(heading, status, count, stop, pause, grant, use, start);
  section.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:24px";
  document.querySelector("main")?.append(section);
  context.select(workspaceID);
  context.setWritable(workspaceID, false);
}

if (new URL(window.location.href).searchParams.has("statusbar")) {
  // The same structure Theia's status bar renders, styled by its own and Factory's CSS.
  const bar = document.createElement("div");
  bar.id = "theia-statusBar";
  bar.style.cssText = "position:fixed;inset:auto 0 0";
  const entry = (id: string, text: string) => {
    const element = document.createElement("div");
    element.id = `status-bar-${id}`;
    element.className = "element";
    const label = document.createElement("span");
    label.textContent = text;
    element.title = text;
    element.append(label);
    return element;
  };
  const full = new URL(window.location.href).searchParams.get("statusbar") === "full";
  const left = document.createElement("div");
  left.className = "area left";
  if (full) {
    // The entries the running IDE shows beside a TypeScript file.
    left.append(
      entry("factory-editor-settings", "Editor settings"),
      entry("factory-editor-save-mode", "Save: manual"),
      entry("factory-buffer-workspace", "File · Personal · ACME Astro"),
      entry("factory-writing", "You are editing this implementation."),
      entry("problem-marker-status", "0 0"),
      entry("session-preference-status", "Session Preferences (1)"),
    );
    const right = document.createElement("div");
    right.className = "area right";
    right.append(
      entry("editor-status-cursor-position", "Ln 1, Col 1"),
      entry("editor-status-eol", "LF"),
      entry("editor-status-encoding", "UTF-8"),
      entry("editor-status-tabbing-config", "Spaces: 2"),
      entry("factory-language-tools", "TypeScript · Start tools"),
      entry("editor-language-status-items", "{}"),
      entry("editor-status-language", "JavaScript"),
      entry("theia-notification-center", "!"),
      entry("bottom-panel-toggle", "^"),
    );
    bar.append(left, right);
    document.body.append(bar);
  } else
    left.append(
      entry(
        "factory-buffer-workspace",
        "Ticket · A deliberately long Workspace name for this editor",
      ),
      entry(
        "factory-writing",
        "Agent working · requested by Local administrator with a long explanatory sentence. Observation mode. Files remain available to read.",
      ),
    );
  if (!full) {
    const right = document.createElement("div");
    right.className = "area right";
    right.append(
      entry("session-preference-status", "Save: manual"),
      entry("editor-status-cursor-position", "Ln 12, Col 4"),
    );
    bar.append(left, right);
    document.body.append(bar);
  }
}
