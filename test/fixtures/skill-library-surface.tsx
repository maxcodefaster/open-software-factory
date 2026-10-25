import { render } from "@solidjs/web";
import { SkillLibrary } from "../../apps/factory/src/skills/library";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/settings-workspace.css";

render(
  () => (
    <main class="factory-desktop settings-content" style={{ height: "100dvh" }}>
      <SkillLibrary active />
    </main>
  ),
  document.getElementById("root")!,
);
