import { render } from "@solidjs/web";
import { DeveloperIDEWorkspace } from "../../apps/factory/src/developer-ide-workspace";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/runtime-workspace.css";

render(
  () => (
    <main style={{ height: "100vh", padding: "24px", display: "flex", "flex-direction": "column" }}>
      <h1>Workspace recovery fixture</h1>
      <DeveloperIDEWorkspace
        userID="10000000-0000-4000-8000-000000000001"
        projectID="10000000-0000-4000-8000-000000000002"
        workspaceID="10000000-0000-4000-8000-000000000003"
        active
        allowed
        onDevelopmentPreview={() => {}}
      />
    </main>
  ),
  document.getElementById("root")!,
);
