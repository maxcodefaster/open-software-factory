import { render } from "@solidjs/web";
import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import { createAgentCommandIds } from "../../apps/factory/src/agent-command-ids";
import type { TicketDetail } from "../../apps/factory/src/desktop/contracts";
import { createDesktopReads } from "../../apps/factory/src/desktop/reads";
import { createTicketCommands } from "../../apps/factory/src/desktop/ticket-commands";
import { type TicketDraft, TicketWorkspace } from "../../apps/factory/src/ticket-workspace";
import { createWorkspaceState } from "../../apps/factory/src/workspace/state";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import { selectedWorkspaceTab, type WorkspaceTab } from "../../apps/factory/src/workspace-tabs";
import {
  originalTitle,
  otherTitleProjectID,
  otherTitleTicketID,
  titleProjectID,
  titleTicketID,
} from "./ticket-tab-title";
import { fixtureValue } from "./value";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

const noop = () => {};
const tabsOnly = new URLSearchParams(location.search).has("tabs-only");
function Surface() {
  const [projectID, setProjectID] = createSignal<string | undefined>(titleProjectID);
  const [ticketID, setTicketID] = createSignal<string | undefined>(titleTicketID);
  const [detail, setDetail] = createSignal<TicketDetail>();
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [completedReads, setCompletedReads] = createSignal(0);
  const workspaces = createWorkspaceState(projectID);
  const ticketTab = (id: string, label: string): WorkspaceTab => ({
    id: `ticket:${id}`,
    view: "ticket",
    ticketID: id,
    label,
  });
  onSettled(() => {
    workspaces.open(ticketTab(titleTicketID, originalTitle));
    workspaces.open(ticketTab(otherTitleTicketID, "Another Ticket"));
    workspaces.open({
      id: "ide:custom",
      view: "ide",
      ticketID: titleTicketID,
      label: "My custom IDE label",
    });
    workspaces.activate(ticketTab(titleTicketID, originalTitle));
  });
  const drafts = new Map<string, TicketDraft>();
  let generation = 0,
    disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const reads = createDesktopReads({
    selectedProjectID: projectID,
    selectedTicketID: ticketID,
    detail,
    setDetail,
    workspaces,
    workspaceTabs: workspaces.tabs,
    get ticketReadGeneration() {
      return generation;
    },
    set ticketReadGeneration(value: number) {
      generation = value;
    },
    get workspaceDisposed() {
      return disposed;
    },
    selectedChange: () => undefined,
    agentOpen: () => false,
    assistantTicketID: ticketID,
    selectedConversation: () => undefined,
    conversationReadFence: { beginRead: () => 0, currentRead: () => true },
    setChanges: noop,
    setAttempts: noop,
    setAppPreviews: noop,
    setLifecycleProjectID: noop,
    resetAgentView: noop,
    setDelivery: noop,
    setSyncError: setError,
    setConversation: noop,
    acknowledgeConversation: noop,
    publishConversation: noop,
    setError,
    refreshKnowledge: async () => {},
  } as unknown as Parameters<typeof createDesktopReads>[0]);
  const commands = createTicketCommands({
    detail,
    latestRevision: () => detail()?.revisions[0],
    selectedProjectID: projectID,
    selectedTicketID: ticketID,
    refreshTicketDetail: reads.refreshTicketDetail,
    agentCommandIds: createAgentCommandIds({ userId: "isolated-tab-title", storage: localStorage }),
    acknowledgeCommand: noop,
    async mutate<T>(operation: () => Promise<T>) {
      setPending(true);
      try {
        return { ok: true, value: await operation() };
      } catch (cause) {
        setError(String(cause));
        return { ok: false };
      } finally {
        setPending(false);
      }
    },
    setAgentOpen: () => false,
    refreshConversation: reads.refreshConversation,
  } as unknown as Parameters<typeof createTicketCommands>[0]);
  function activate(tab: WorkspaceTab) {
    workspaces.activate(tab);
    if (tab.view !== "ticket") return;
    generation++;
    setTicketID(tab.ticketID);
    setDetail(undefined);
    onSettled(() => void refresh());
  }
  async function refresh() {
    try {
      await reads.refreshTicketDetail();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCompletedReads((count) => count + 1);
    }
  }
  function switchProject() {
    generation++;
    const next = projectID() === titleProjectID ? otherTitleProjectID : titleProjectID;
    setProjectID(next);
    setTicketID(titleTicketID);
    setDetail(undefined);
    onSettled(() => {
      if (!workspaces.tabs().length)
        workspaces.open(ticketTab(titleTicketID, "Other Project Ticket"));
    });
  }
  return (
    <main class="factory-desktop" data-background="river-landscape">
      <header class="factory-topbar">
        <div class="topbar-start">
          <span class="context-button">Saved Ticket title · Isolated fixture</span>
          <button type="button" class="quiet-button" onClick={() => void refresh()}>
            Read saved Ticket
          </button>
          <button type="button" class="quiet-button" onClick={switchProject}>
            Switch fixture Project
          </button>
          <output aria-label="Completed fixture reads">{completedReads()}</output>
        </div>
      </header>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <section class="workspace-window" aria-label="Ticket workspace">
        <WorkspaceTabbar
          tabs={workspaces.tabs()}
          activeTabID={workspaces.current()?.activeTabID}
          onActivate={activate}
          onClose={(id) => workspaces.close(id)}
          onMinimize={noop}
        />
        <div class="workspace-view-body">
          <Show when={tabsOnly}>
            <output aria-label="Saved fixture Ticket title">{detail()?.ticket.title}</output>
          </Show>
          <Show when={!tabsOnly && detail()}>
            {(current) => (
              <TicketWorkspace
                current={current()}
                projectID={projectID()}
                active={selectedWorkspaceTab(workspaces.current())?.view === "ticket"}
                storageKey={`tab-title:${projectID()}:${ticketID()}`}
                ticketReference="TIP-1"
                pending={pending()}
                epics={[]}
                drafts={drafts}
                dependencies={{
                  prerequisites: [],
                  candidates: [],
                  admitted: false,
                  pending: false,
                  onOpen: noop,
                  onAdd: async () => false,
                  onRemove: noop,
                }}
                onAssignEpic={noop}
                onInterview={noop}
                onSaveDocument={commands.saveTicketDocument}
                onConfirmRequirements={commands.confirmRequirements}
                clarificationAction={{ label: "Ask AI to clarify", status: false }}
                onFollowUp={noop}
                onOpenTicket={noop}
                onOpenEpic={noop}
                onTrash={noop}
                onRestore={noop}
                onImplement={noop}
                onCodingOptions={noop}
                codingOptionsOpen={false}
                implementationAvailable={false}
                onStopImplementation={noop}
                onOpenIDE={noop}
                onApproveDelivery={noop}
                canDevelop={false}
              />
            )}
          </Show>
        </div>
      </section>
    </main>
  );
}
render(() => <Surface />, fixtureValue(document.getElementById("root"), "fixture root"));
