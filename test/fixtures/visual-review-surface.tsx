import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { ReviewPanel } from "../../apps/factory/src/review/panel";
import { RuntimeWorkspaceTabs } from "../../apps/factory/src/runtime-workspace";
import {
  WorkspaceTabbar,
  workspacePanelID,
  workspaceTabElementID,
} from "../../apps/factory/src/workspace-tabbar";
import { DockButton } from "../../apps/factory/src/dock";
import {
  openWorkspaceTabState,
  closeWorkspaceTabState,
  type ProjectWorkspaceState,
} from "../../apps/factory/src/workspace-tabs";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/runtime-workspace.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

const query = new URLSearchParams(location.search);
const changeID = fixtureValue(query.get("change"), 'query.get("change")');
const userID = fixtureValue(query.get("user"), 'query.get("user")');
const attemptID = fixtureValue(query.get("attempt"), 'query.get("attempt")');
const projectID = query.get("project") ?? crypto.randomUUID();
const boundToTicket = query.get("unbound") !== "1";
const ticketTab = {
  id: "ticket:owned-review",
  view: "ticket" as const,
  label: "Validation review",
};
const previewTab = {
  id: "preview:owned-review",
  view: "preview" as const,
  label: "Development · Form",
  attemptID,
  appChannel: "app",
};
function Surface() {
  const [state, setState] = createSignal<ProjectWorkspaceState>({
    tabs: [ticketTab],
    activeTabID: ticketTab.id,
  });
  const [visible, setVisible] = createSignal(true);
  const open = (tab: typeof ticketTab | typeof previewTab) => {
    setState((current) => openWorkspaceTabState(current, tab));
    setVisible(true);
  };
  return (
    <main class="factory-desktop" data-background="river-landscape">
      <header class="factory-topbar">
        <div class="topbar-start">
          <span class="context-button">Review UI · scripted fixture</span>
        </div>
        <nav class="factory-dock" aria-label="Factory apps">
          <DockButton
            label="Ticket"
            icon="ticket"
            active={visible() && state().activeTabID === ticketTab.id}
            onClick={() => open(ticketTab)}
            onMinimize={() => setVisible(false)}
          />
          <DockButton
            label="Preview"
            icon="preview"
            active={visible() && state().activeTabID === previewTab.id}
            onClick={() => open(previewTab)}
            onMinimize={() => setVisible(false)}
          />
        </nav>
      </header>
      <section class="workspace-window" hidden={!visible()} aria-label="Owned review workspace">
        <WorkspaceTabbar
          tabs={state().tabs}
          activeTabID={state().activeTabID}
          onActivate={(tab) => setState((current) => ({ ...current, activeTabID: tab.id }))}
          onClose={(id) => setState((current) => closeWorkspaceTabState(current, id).state)}
          onMinimize={() => setVisible(false)}
        />
        <div
          class="workspace-view-body"
          id={workspacePanelID}
          role="tabpanel"
          aria-labelledby={
            state().activeTabID
              ? workspaceTabElementID(fixtureValue(state().activeTabID, "state().activeTabID"))
              : undefined
          }
        >
          <Show when={state().activeTabID === ticketTab.id}>
            <div class="ticket-workspace" style={{ "grid-column": "1 / -1" }}>
              <article class="ticket-document has-review">
                <header class="ticket-document-heading">
                  <div class="ticket-status-context">
                    TCK-QA · Independent review · scripted test data
                  </div>
                  <h2 class="ticket-inline-title">Keep a draft after validation fails</h2>
                  <ReviewPanel
                    changeID={changeID}
                    userID={userID}
                    canDevelop
                    active={visible()}
                    onOpenPreview={() => open(previewTab)}
                  />
                </header>
                <details>
                  <summary>Requirements</summary>
                  <p>
                    Keep the entered draft and show an error when a title is empty. This fixture
                    does not represent a model QA run.
                  </p>
                </details>
              </article>
            </div>
          </Show>
          <RuntimeWorkspaceTabs
            projectID={projectID}
            tabs={state().tabs}
            activeTabID={visible() ? state().activeTabID : undefined}
            attempts={[
              {
                id: attemptID,
                projectId: projectID,
                ...(boundToTicket ? { changeId: changeID } : {}),
                workspaceId: "owned-workspace",
                workspaceKind: "ticket",
                state: "ready",
              },
            ]}
            previews={[{ attemptID, projectID, channel: "app", label: "Form" }]}
            pending={false}
            userID={userID}
            canDevelop
            onOpenTicket={() => open(ticketTab)}
          />
        </div>
      </section>
    </main>
  );
}
render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
