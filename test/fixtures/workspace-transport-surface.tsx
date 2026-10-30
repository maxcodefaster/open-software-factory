import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { DeveloperIDEWorkspace } from "../../apps/factory/src/developer-ide-workspace";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/runtime-workspace.css";
import { fixtureValue } from "./value";

render(
  () => {
    const [active, setActive] = createSignal(
      !new URL(window.location.href).searchParams.has("hidden"),
    );
    return (
      <main
        style={{ height: "100vh", padding: "24px", display: "flex", "flex-direction": "column" }}
      >
        <h1>Workspace recovery fixture</h1>
        <button class="quiet-button" type="button" onClick={() => setActive((value) => !value)}>
          {active() ? "Hide editor" : "Show editor"}
        </button>
        <DeveloperIDEWorkspace
          userID="10000000-0000-4000-8000-000000000001"
          projectID="10000000-0000-4000-8000-000000000002"
          workspaceID="10000000-0000-4000-8000-000000000003"
          active={active()}
          allowed
          onDevelopmentPreview={() => {}}
        />
      </main>
    );
  },
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
