import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { MCPLibrary } from "../../apps/factory/src/mcp/library";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/settings-workspace.css";
import { fixtureValue } from "./value";

const [projectID, setProjectID] = createSignal<string>();
const switching = new URLSearchParams(location.search).has("switch-project");
render(
  () => (
    <main class="factory-desktop settings-content" style={{ height: "100dvh" }}>
      <Show when={switching}>
        <button type="button" onClick={() => setProjectID("10000000-0000-4000-8000-000000000003")}>
          Switch fixture Project
        </button>
      </Show>
      <MCPLibrary active projectId={projectID()} />
    </main>
  ),
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
