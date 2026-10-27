import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { SettingsWorkspace } from "../../apps/factory/src/settings-workspace";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";

const root = document.getElementById("root");
if (!root) throw new Error("Environment fixture root is missing");
const [projectID, setProjectID] = createSignal("10000000-0000-4000-8000-000000000001");
const switching = new URLSearchParams(location.search).has("switch-project");
render(
  () => (
    <main class="factory-desktop">
      <header class="factory-topbar">
        <span class="context-button">Invoice workspace</span>
        <Show when={switching}>
          <button
            type="button"
            onClick={() => setProjectID("10000000-0000-4000-8000-000000000003")}
          >
            Switch fixture Project
          </button>
        </Show>
      </header>
      <section class="workspace-window" aria-label="Settings">
        <WorkspaceTabbar
          tabs={[{ id: "settings", view: "settings", label: "Settings" }]}
          activeTabID="settings"
          onActivate={() => {}}
          onClose={() => {}}
          onMinimize={() => {}}
        />
        <SettingsWorkspace
          active
          userID="10000000-0000-4000-8000-000000000002"
          project={{ id: projectID(), name: "Invoice workspace" }}
          systemManager
          projectManager
          developer
        />
      </section>
    </main>
  ),
  root,
);
