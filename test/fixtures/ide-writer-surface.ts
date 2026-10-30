import "../../deploy/theia-ide/node_modules/@theia/core/src/browser/style/index.css";
import "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-ide.css";
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
