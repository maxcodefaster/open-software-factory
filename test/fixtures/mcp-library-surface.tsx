import { render } from "@solidjs/web";
import { MCPLibrary } from "../../apps/factory/src/mcp/library";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/settings-workspace.css";

render(
  () => (
    <main class="factory-desktop settings-content" style={{ height: "100dvh" }}>
      <MCPLibrary active />
    </main>
  ),
  document.getElementById("root")!,
);
