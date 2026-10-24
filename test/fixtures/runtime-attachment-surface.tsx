import { createSignal } from "solid-js";
import { render } from "@solidjs/web";
import { RuntimeWorkspace } from "../../apps/factory/src/runtime-workspace";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { MarkdownReader } from "../../apps/factory/src/markdown-reader";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

const attemptID = "11111111-1111-4111-8111-111111111111";
function Surface() {
  const [selected, setSelected] = createSignal(false);
  return (
    <main style="max-width: 900px; margin: 20px auto; background: var(--surface-raised); padding: 20px">
      <h1>Factory attachment regression</h1>
      <section style="height: 380px; position: relative" aria-label="Preview fixture">
        <RuntimeWorkspace
          title="Preview"
          attemptID={attemptID}
          url={`${appRuntimeOrigin(location.origin, attemptID, "app")}/document`}
          loadingLabel="Opening Preview…"
        />
      </section>
      <MarkdownReader
        class="knowledge-article markdown-body"
        label="Wiki fixture"
        value={
          selected() ? "Verified linked guidance." : "Saved human note. See #wiki/task-management."
        }
        wikiPages={[{ slug: "task-management", title: "Managing tasks" }]}
        onNavigate={(href) => {
          if (href !== "#wiki/task-management") return false;
          setSelected(true);
          return true;
        }}
      />
    </main>
  );
}
render(() => <Surface />, document.getElementById("root")!);
