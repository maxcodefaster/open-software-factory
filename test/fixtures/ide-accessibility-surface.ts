import { installAccessibility } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-accessibility";

// The structure Theia 1.76 renders, reduced to the parts the hardening touches.
document.body.innerHTML = `
  <div id="theia-app-shell">
    <div id="theia-left-content-panel">
      <ul role="tablist" aria-orientation="vertical" id="activity">
        <li id="tab-explorer" class="lm-TabBar-tab lm-mod-current"><div class="theia-tab-icon-label"><div class="lm-TabBar-tabLabel" style="width:0;height:0">Explorer</div></div></li>
        <li id="tab-search" class="lm-TabBar-tab"><div class="theia-tab-icon-label"><div class="lm-TabBar-tabLabel" style="width:0;height:0">Search</div></div></li>
      </ul>
    </div>
    <div id="theia-main-content-panel"><ul role="tablist" aria-orientation="horizontal" id="editors"></ul></div>
    <div id="theia-bottom-content-panel"></div>
    <div id="theia-statusBar">
      <div class="area left">
        <div id="entry-command" class="element hasCommand" aria-label="Editor settings">Editor settings</div>
        <div id="entry-static" class="element" aria-label="Save: manual">Save: manual</div>
      </div>
    </div>
  </div>`;
const stop = installAccessibility(document);
Object.assign(window, { stopAccessibility: stop });
