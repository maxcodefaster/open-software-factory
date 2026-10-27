import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { isDesktopBackgroundKey } from "../../packages/interface-domain/src/background";
import type { KnowledgePage, Ticket } from "../../apps/factory/src/api-contracts";
import { KnowledgeWorkspace } from "../../apps/factory/src/knowledge-workspace";
import { SignIn } from "../../apps/factory/src/sign-in";
import { TicketBoardContents } from "../../apps/factory/src/ticket-board";
import { TicketWorkspace, type TicketDraft } from "../../apps/factory/src/ticket-workspace";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/knowledge-workspace.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

const parameters = new URLSearchParams(location.search);
const surface = parameters.get("surface") ?? "wiki";
const requestedBackground = parameters.get("background");
const background = isDesktopBackgroundKey(requestedBackground)
  ? requestedBackground
  : "river-landscape";
const projectID = "10000000-0000-4000-8000-000000000001";
const userID = "10000000-0000-4000-8000-000000000002";
const noAction = () => {};
const sentence = "Release context stays readable while formatting the approved delivery scope. ";
export const wikiSaveAttempts: unknown[] = [];

function Wiki() {
  const pages: KnowledgePage[] = ["Invoice exports", "Billing rules"].map((title, index) => ({
    id: `10000000-0000-4000-8000-00000000001${index}`,
    projectId: projectID,
    slug: `guide-${index}`,
    title,
    currentBody:
      index === 0
        ? "## Export workflow\n\nChoose a billing period, review the selected invoices, then download the export.\n\n## Empty periods\n\nAn empty billing period shows a clear message without creating an export."
        : "## Billing periods\n\nUse the account's billing period when preparing invoice exports.",
    state: "active",
    version: 1,
    parentId: null,
    sortOrder: index,
    icon: "knowledge",
    metadataVersion: 1,
    currentRevisionId: null,
  }));
  const [selected, setSelected] = createSignal(pages[0]?.id);
  const document = parameters.has("document")
    ? {
        path: "README.md",
        title: "Repository guide",
        body: "Repository documents remain read-only in the Wiki.",
        blobSha: "a".repeat(40),
        commitSha: "b".repeat(40),
      }
    : undefined;
  return (
    <KnowledgeWorkspace
      pages={pages}
      selectedPage={pages.find((page) => page.id === selected())}
      openDocument={document}
      documents={[]}
      revisions={[]}
      searchResults={[]}
      searchQuery=""
      pending={false}
      projectID={projectID}
      userID={userID}
      repositoryURL="https://example.invalid/glass-proof.git"
      canDevelop={false}
      drafts={new Map()}
      onSelectPage={setSelected}
      onOpenDocument={noAction}
      onGenerate={noAction}
      onSearch={noAction}
      onSavePage={async (...input) => {
        wikiSaveAttempts.push(input);
        throw new Error("This visual fixture does not persist edits.");
      }}
      onHistory={async () => {}}
      onSources={async () => []}
      onArchive={noAction}
      onMove={async () => {}}
      onIcon={async () => {}}
      onOpenIDE={noAction}
      onRestore={async () => {
        throw new Error("This visual fixture does not restore revisions.");
      }}
    />
  );
}

function Archive() {
  const [selected, setSelected] = createSignal("");
  const tickets: Ticket[] = [
    "Export invoices as CSV",
    "Show empty billing periods",
    "Legacy export endpoint",
  ].map((title, index) => ({
    id: `10000000-0000-4000-8000-00000000002${index}`,
    projectId: projectID,
    epicId: null,
    title,
    description: "Synthetic archived work for the material proof.",
    state: index === 2 ? "cancelled" : "done",
    version: 1,
  }));
  return (
    <section class="kanban-desktop" aria-label="Ticket board">
      <TicketBoardContents
        tickets={[]}
        epics={[]}
        archivedTickets={tickets}
        historyOpen
        pending={false}
        selectedTicketID={selected()}
        stage={() => "history"}
        status={(ticket) => (ticket.state === "cancelled" ? "Cancelled" : "Delivered")}
        blockers={() => []}
        reference={(id) => `TCK-${tickets.findIndex((ticket) => ticket.id === id) + 1}`}
        onSelect={setSelected}
        epicID=""
        onEpic={noAction}
        onSaveEpic={async () => false}
      />
      <p class="sr-only" role="status">
        {selected() ? "Archived Ticket selected" : ""}
      </p>
    </section>
  );
}

function Editor() {
  return (
    <TicketWorkspace
      current={{
        ticket: {
          id: "10000000-0000-4000-8000-000000000030",
          title: "Improve invoice exports",
          description: parameters.has("dense")
            ? sentence.repeat(100).trim()
            : "Customers need one CSV file for a selected billing period.\n\nInclude invoice numbers, dates and totals. Keep existing access checks and show a clear message for empty periods.",
          state: "inbox",
          version: 1,
        },
        revisions: [],
        documentRevisions: [],
        origin: null,
        followUps: [],
      }}
      storageKey="glass-proof:editor"
      ticketReference="TCK-4"
      pending={false}
      epics={[]}
      drafts={new Map<string, TicketDraft>()}
      dependencies={{
        prerequisites: [],
        candidates: [],
        admitted: false,
        pending: false,
        onOpen: noAction,
        onAdd: async () => false,
        onRemove: noAction,
      }}
      onAssignEpic={noAction}
      onInterview={noAction}
      onWriteRequirements={noAction}
      onSaveDocument={async () => undefined}
      onConfirmRequirements={async () => undefined}
      clarificationAction={{ label: "Ask AI to clarify", status: false }}
      onFollowUp={noAction}
      onOpenTicket={noAction}
      onOpenEpic={noAction}
      onTrash={noAction}
      onRestore={noAction}
      onImplement={noAction}
      onCodingOptions={noAction}
      codingOptionsOpen={false}
      implementationAvailable={false}
      onStopImplementation={noAction}
      onOpenIDE={noAction}
      onApproveDelivery={noAction}
      canDevelop={false}
      userID={userID}
    />
  );
}

function Surface() {
  const [error, setError] = createSignal("");
  return (
    <Show
      when={surface !== "signin"}
      fallback={<SignIn error={error()} setError={setError} background={background} />}
    >
      <main
        class="factory-desktop"
        data-background={background}
        aria-label="Glass material proof with synthetic data"
      >
        <header class="factory-topbar">
          <div class="topbar-start">
            <span class="context-button">Invoice workspace</span>
          </div>
        </header>
        <Show when={surface !== "archive"} fallback={<Archive />}>
          <section class="workspace-window" aria-label="Material proof window">
            <WorkspaceTabbar
              tabs={[
                {
                  id: "material",
                  view: surface === "editor" ? "ticket" : "knowledge",
                  label: surface === "editor" ? "Improve invoice exports" : "Wiki",
                },
              ]}
              activeTabID="material"
              onActivate={noAction}
              onClose={noAction}
              onMinimize={noAction}
            />
            <div class="workspace-view-body">
              <Show when={surface === "editor"} fallback={<Wiki />}>
                <Editor />
              </Show>
            </div>
          </section>
        </Show>
      </main>
    </Show>
  );
}

render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
