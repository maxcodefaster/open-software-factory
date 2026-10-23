import { render } from "@solidjs/web";
import { SettingsWorkspace } from "../../apps/factory/src/settings-workspace";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

const manager = new URLSearchParams(location.search).get("role") !== "viewer";
render(
  () => (
    <main style="height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--material-panel)">
      <header style="padding:12px 24px;border-bottom:1px solid var(--line-subtle);font:var(--text-xs) var(--font-interface)">
        Factory settings · Isolated component proof with synthetic requests
      </header>
      <SettingsWorkspace
        active
        userID="10000000-0000-4000-8000-000000000002"
        project={{ id: "10000000-0000-4000-8000-000000000001", name: "Invoice workspace" }}
        systemManager={manager}
        projectManager={manager}
        developer={manager}
      />
    </main>
  ),
  document.getElementById("root")!,
);
