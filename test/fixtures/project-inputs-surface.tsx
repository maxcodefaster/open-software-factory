import { render } from "@solidjs/web";
import { SettingsWorkspace } from "../../apps/factory/src/settings-workspace";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import { FixtureReads } from "./factory-read-provider";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import { fixtureValue } from "./value";

const manager = new URLSearchParams(location.search).get("role") !== "viewer";
render(
  () => (
    <main class="factory-desktop" aria-label="Isolated settings proof with synthetic requests">
      <header class="factory-topbar">
        <div class="topbar-start">
          <span class="context-button">Invoice workspace</span>
        </div>
      </header>
      <section class="workspace-window" aria-label="Settings window">
        <WorkspaceTabbar
          tabs={[{ id: "settings", view: "settings", label: "Settings" }]}
          activeTabID="settings"
          onActivate={() => {}}
          onClose={() => {}}
          onMinimize={() => {}}
        />
        <div class="workspace-view-body">
          <div class="settings-tab-panel">
            <FixtureReads>
              <SettingsWorkspace
                active
                userID="10000000-0000-4000-8000-000000000002"
                project={{ id: "10000000-0000-4000-8000-000000000001", name: "Invoice workspace" }}
                systemManager={manager}
                projectManager={manager}
                developer={manager}
                initialSelection={
                  new URLSearchParams(location.search).has("inputs-first")
                    ? { scope: "project", category: "monitoring" }
                    : undefined
                }
              />
            </FixtureReads>
          </div>
        </div>
      </section>
    </main>
  ),
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
