import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { TechnicalDesignRevision } from "../../apps/factory/src/api-contracts";
import type { TicketAttention } from "../../apps/factory/src/inbox/contracts";
import { TicketPeople } from "../../apps/factory/src/inbox/ticket-people";
import { type TicketDraft, TicketWorkspace } from "../../apps/factory/src/ticket-workspace";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import { planningDesign, planningProduct } from "./technical-planning";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

declare const __PLANNING_DIAGRAM__: string;
const query = new URLSearchParams(location.search);
const contributor = query.has("contributor");
const empty = query.has("empty");
const stale = query.has("stale");
const review = query.has("review");
const productID = "10000000-0000-4000-8000-000000000003";
const noop = () => {};

function Surface() {
  const [second, setSecond] = createSignal(false);
  const [action, setAction] = createSignal("");
  const [busy, setBusy] = createSignal(query.has("busy"));
  const [technicalPending, setTechnicalPending] = createSignal(
    query.has("unresolved") || query.has("busy"),
  );
  const [commands, setCommands] = createSignal({ work: 0, saves: 0, approvals: 0 });
  const [queued, setQueued] = createSignal(query.has("queued"));
  const [commissioned, setCommissioned] = createSignal(query.has("queued"));
  let finishSave: (() => void) | undefined;
  const commission = (label: string) => {
    setCommands((value) => ({ ...value, work: value.work + 1 }));
    setAction(label);
  };
  const [people, setPeople] = createSignal<TicketAttention>({
    responsibleId: null,
    version: 0,
    following: false,
    people: [
      {
        id: "10000000-0000-4000-8000-000000000008",
        name: "Lisa Product",
        develop: false,
        manage: false,
      },
      {
        id: "10000000-0000-4000-8000-000000000009",
        name: "Tom Development",
        develop: true,
        manage: true,
      },
    ],
  });
  const [design, setDesign] = createSignal<TechnicalDesignRevision>({
    id: "10000000-0000-4000-8000-000000000004",
    ordinal: 1,
    requirementRevisionId: productID,
    sourceCommit: "a".repeat(40),
    content: planningDesign,
    citations: [
      {
        source: "code",
        id: "10000000-0000-4000-8000-000000000001",
        label: "Synthetic invoice source",
        path: "apps/billing/invoices.ts",
        commitSha: "a".repeat(40),
      },
    ],
    diagramRenders: [__PLANNING_DIAGRAM__],
    rendererVersion: "fixture/pinned-renderer",
    authorKind: "ai",
    createdAt: "2026-10-26T10:00:00Z",
    approved: false,
  });
  const product = () => ({
    id: stale ? "10000000-0000-4000-8000-000000000005" : productID,
    ordinal: stale ? 2 : 1,
    canonicalContent: JSON.stringify(planningProduct),
    contentDigest: "b".repeat(64),
    ...(commissioned() ? { approvalId: "10000000-0000-4000-8000-000000000011" } : {}),
  });
  const plan = () => {
    commission("Technical planning commissioned");
    setTechnicalPending(true);
    setBusy(true);
  };
  return (
    <main
      class="factory-desktop"
      data-background="river-landscape"
      aria-label="Synthetic Ticket planning fixture"
    >
      <header class="factory-topbar">
        <div class="topbar-start">
          <span class="context-button">Billing · Synthetic fixture</span>
          <Show when={query.has("switchable")}>
            <button
              type="button"
              onClick={() => {
                setSecond(true);
                setDesign({
                  ...design(),
                  id: "10000000-0000-4000-8000-000000000007",
                  content: { ...planningDesign, context: "A different Ticket's source context." },
                });
              }}
            >
              Switch fixture Ticket
            </button>
          </Show>
          <Show when={query.has("defer-save")}>
            <button type="button" onClick={() => finishSave?.()}>
              Finish fixture save
            </button>
          </Show>
        </div>
      </header>
      <section class="workspace-window" aria-label="Ticket workspace">
        <WorkspaceTabbar
          tabs={[{ id: "planning", view: "ticket", label: "Export invoices as CSV" }]}
          activeTabID="planning"
          onActivate={noop}
          onClose={noop}
          onMinimize={noop}
        />
        <div class="workspace-view-body">
          <TicketWorkspace
            current={{
              ticket: {
                id: "10000000-0000-4000-8000-000000000002",
                title: "Export invoices as CSV",
                description:
                  "Customers need a portable record of the invoices in a billing period.",
                state: "ready",
                version: 1,
              },
              revisions: [product()],
              documentRevisions: [],
              origin: null,
              followUps: [],
              technicalDesigns: contributor || empty ? [] : [design()],
              technicalDesignPresent: !empty,
              technicalPlanningPending: technicalPending(),
              implementationOrder: queued()
                ? {
                    commandId: "10000000-0000-4000-8000-000000000012",
                    state: "waiting",
                    reason: null,
                  }
                : null,
            }}
            latestRevision={product()}
            latestRequirement={planningProduct}
            change={
              review
                ? {
                    id: "10000000-0000-4000-8000-000000000010",
                    state: "active",
                    baseSha: "a".repeat(40),
                    branchName: "factory/synthetic-review",
                    implementationState: "committed",
                    buildTurnState: "completed",
                  }
                : undefined
            }
            delivery={
              review ? { verificationState: "succeeded", reviewState: "passed" } : undefined
            }
            userID={review ? "10000000-0000-4000-8000-000000000009" : undefined}
            storageKey={`ticket-planning:synthetic-user:${second() ? "second" : "first"}`}
            ticketReference="BILL-24"
            pending={false}
            epics={[]}
            drafts={new Map<string, TicketDraft>()}
            dependencies={{
              prerequisites: query.has("prerequisite")
                ? [
                    {
                      id: "10000000-0000-4000-8000-000000000013",
                      title: "Deliver invoice storage",
                      state: "in-progress",
                      delivered: false,
                    },
                  ]
                : [],
              candidates: [],
              admitted: false,
              pending: false,
              onOpen: noop,
              onAdd: async () => false,
              onRemove: noop,
            }}
            onAssignEpic={noop}
            people={
              <TicketPeople
                value={people()}
                busy={false}
                onAssign={async (responsibleId) =>
                  setPeople((value) => ({ ...value, responsibleId, version: value.version + 1 }))
                }
                onFollow={async (following) => setPeople((value) => ({ ...value, following }))}
              />
            }
            onInterview={() => commission("Product interview commissioned")}
            onFullPlanning={() => {
              commission("Full planning commissioned");
              setBusy(true);
            }}
            onTechnicalPlanning={plan}
            planningBusy={busy()}
            onSaveTechnicalDesign={async (_id, content) => {
              setCommands((value) => ({ ...value, saves: value.saves + 1 }));
              if (query.has("defer-save"))
                await new Promise<void>((resolve) => {
                  finishSave = resolve;
                });
              if (query.has("fail")) return false;
              setDesign({
                ...design(),
                id: "10000000-0000-4000-8000-000000000006",
                ordinal: 2,
                content,
                authorKind: "human",
              });
              setAction("Technical design saved");
              return true;
            }}
            onWriteRequirements={noop}
            onSaveDocument={async () => undefined}
            onConfirmRequirements={async () => undefined}
            clarificationAction={{ label: "Ask AI to clarify", status: false }}
            onFollowUp={noop}
            onOpenTicket={noop}
            onOpenEpic={noop}
            onTrash={noop}
            onRestore={noop}
            onImplement={() => {
              commission("Exact planning scope commissioned");
              setCommissioned(true);
              if (query.has("prerequisite")) setQueued(true);
            }}
            onCodingOptions={noop}
            codingOptionsOpen={false}
            implementationAvailable
            onStopImplementation={noop}
            onCancelImplementation={() => {
              setQueued(false);
              setAction("Queued implementation cancelled");
            }}
            onOpenIDE={noop}
            onApproveDelivery={() =>
              setCommands((value) => ({ ...value, approvals: value.approvals + 1 }))
            }
            canDevelop={!contributor}
          />
        </div>
      </section>
      <output class="sr-only" aria-label="Fixture action">
        {action()}
      </output>
      <output class="sr-only" aria-label="Fixture commands">
        {JSON.stringify(commands())}
      </output>
      <output class="sr-only" aria-label="Fixture design approved">
        {String(design().approved)}
      </output>
    </main>
  );
}
render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
