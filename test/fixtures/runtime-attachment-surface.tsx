import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { MarkdownReader } from "../../apps/factory/src/markdown-reader";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { RuntimeWorkspace, RuntimeWorkspaceTabs } from "../../apps/factory/src/runtime-workspace";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/runtime-workspace.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import type { RuntimeAttempt } from "../../apps/factory/src/api-contracts";
import type { WorkspaceTab } from "../../apps/factory/src/workspace-tabs";
import { fixtureValue } from "./value";

const attemptID = "11111111-1111-4111-8111-111111111111";
function Surface() {
  const [selected, setSelected] = createSignal(false);
  const params = new URLSearchParams(location.search);
  const failureMode = params.has("failed");
  const projectID = "22222222-2222-4222-8222-222222222222";
  const [attempts, setAttempts] = createSignal<RuntimeAttempt[]>([
    {
      id: attemptID,
      projectId: projectID,
      runtimeKind: params.has("ticket") ? "ticket" : "staging",
      currentStaging: !params.has("historical"),
      state: params.get("state") ?? "failed",
      failure: params.has("long")
        ? `Health request failed at https://owned-preview.invalid/${"long-path".repeat(40)}`
        : 'channel "app" process "app" exited with code 7: missing configuration',
    },
  ]);
  const [tab, setTab] = createSignal<WorkspaceTab>({
    id: "failed-preview",
    view: "preview",
    label: "Main Preview",
    attemptID,
  });
  const [starts, setStarts] = createSignal(0);
  const startGate = Promise.withResolvers<void>();
  return (
    <main style="max-width: 900px; margin: 20px auto; background: var(--surface-raised); padding: 20px">
      <h1>Factory attachment regression</h1>
      <section style="height: 380px; position: relative" aria-label="Preview fixture">
        <Show
          when={failureMode}
          fallback={
            <RuntimeWorkspace
              title="Preview"
              attemptID={attemptID}
              url={`${appRuntimeOrigin(location.origin, attemptID, "app")}/${params.has("connection-error") ? "failed-document" : "document"}`}
              loadingLabel="Opening Preview…"
            />
          }
        >
          <p>Scripted Main Preview starts: {starts()}</p>
          <Show when={params.has("defer")}>
            <button type="button" class="quiet-button" onClick={() => startGate.resolve()}>
              Finish scripted start
            </button>
          </Show>
          <RuntimeWorkspaceTabs
            projectID={projectID}
            tabs={[tab()]}
            activeTabID="failed-preview"
            attempts={attempts()}
            previews={[]}
            pending={false}
            userID="33333333-3333-4333-8333-333333333333"
            canDevelop
            onRetryMainPreview={async (requested) => {
              if (requested.id !== "failed-preview" || requested.attemptID !== attemptID)
                throw new Error("Scripted retry received a different Preview identity");
              setStarts((value) => value + 1);
              if (params.has("retry-error")) throw new Error("Start response is unconfirmed.");
              if (params.has("defer")) await startGate.promise;
              const next = "44444444-4444-4444-8444-444444444444";
              setAttempts((values) => [
                ...values.map((attempt) => ({ ...attempt, currentStaging: false })),
                {
                  id: next,
                  projectId: projectID,
                  runtimeKind: "staging",
                  state: "starting",
                  currentStaging: true,
                },
              ]);
              setTab((current) => ({ ...current, attemptID: next }));
            }}
          />
        </Show>
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
render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
