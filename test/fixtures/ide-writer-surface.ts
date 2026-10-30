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
  context.subscribe((value) => {
    status.value = value?.state ?? "loading";
  });
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "theia-button";
  stop.textContent = "Observe external Stop";
  stop.addEventListener("click", () => {
    state = "stopped";
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
  section.append(heading, status, count, stop, grant, use);
  section.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:24px";
  document.querySelector("main")?.append(section);
  context.select(workspaceID, true);
  context.setWritable(workspaceID, false);
}
