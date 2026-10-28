import { render } from "@solidjs/web";
import { SettingsWorkspace } from "../../apps/factory/src/settings-workspace";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";

const root = document.getElementById("root");
if (!root) throw new Error("Mirror fixture root is missing");
render(
  () => (
    <main class="factory-desktop">
      <section class="workspace-window" aria-label="Settings">
        <SettingsWorkspace
          active
          userID="10000000-0000-4000-8000-000000000002"
          project={{ id: "10000000-0000-4000-8000-000000000001", name: "Invoice workspace" }}
          systemManager={!new URLSearchParams(location.search).has("contributor")}
          projectManager={false}
          developer={false}
        />
      </section>
    </main>
  ),
  root,
);
