import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { type ReviewActions, ReviewPanel } from "../../apps/factory/src/review/panel";
import { TicketActionBar } from "../../apps/factory/src/ticket-action-bar";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import { fixtureValue } from "./value";

const query = new URLSearchParams(location.search);
const compact = query.has("compact");
const externalActions = query.has("external-actions");
const feedbackID = query.get("feedback") ?? undefined;

function Surface() {
  const [visible, setVisible] = createSignal(true);
  const [actionSource, setActionSource] = createSignal<() => ReviewActions | undefined>();
  const actions = () => actionSource()?.();
  return (
    <main class="factory-desktop" data-background="river-landscape">
      <header class="factory-topbar">
        <button type="button" class="quiet-button" onClick={() => setVisible(!visible())}>
          {visible() ? "Leave review" : "Return to review"}
        </button>
      </header>
      <section class="workspace-window" aria-label="Review triage fixture">
        <div class="ticket-workspace">
          <article class="ticket-document has-review">
            <h2 class="ticket-inline-title">Review triage</h2>
            <Show when={externalActions && actions()}>
              <TicketActionBar
                actions={[
                  { id: "reload", label: "Reload review", run: () => actions()?.reload() },
                  ...(actions()?.addFeedback
                    ? [
                        {
                          id: "feedback",
                          label: "Add feedback",
                          run: () => actions()?.addFeedback?.(),
                        },
                      ]
                    : []),
                ]}
              />
            </Show>
            <Show when={visible()}>
              <div style={compact ? { width: "20rem", "max-width": "100%" } : undefined}>
                <ReviewPanel
                  changeID="10000000-0000-4000-8000-000000000003"
                  userID="10000000-0000-4000-8000-000000000006"
                  canDevelop
                  active
                  compact={compact}
                  feedbackID={feedbackID}
                  {...(externalActions
                    ? {
                        onActions: (read: (() => ReviewActions | undefined) | undefined) =>
                          setActionSource(() => read),
                      }
                    : {})}
                />
              </div>
            </Show>
          </article>
        </div>
      </section>
    </main>
  );
}

render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
