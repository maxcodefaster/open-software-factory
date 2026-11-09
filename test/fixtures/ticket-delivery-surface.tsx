import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { type TicketDraft, TicketWorkspace } from "../../apps/factory/src/ticket-workspace";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import { planningProduct } from "./technical-planning";
import { deliveryStates } from "./ticket-delivery-states";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

const query = new URLSearchParams(location.search);
const state = fixtureValue(
  deliveryStates[query.get("state") ?? "deliverable"],
  "Unknown delivery fixture state",
);
const productID = "10000000-0000-4000-8000-000000000003";
const noop = () => {};

function Surface() {
  const [action, setAction] = createSignal("");
  const run = (label: string) => () => setAction(label);
  return (
    <main
      class="factory-desktop"
      data-background="river-landscape"
      aria-label="Synthetic Ticket delivery fixture"
    >
      <section class="workspace-window" aria-label="Ticket workspace">
        <WorkspaceTabbar
          tabs={[{ id: "ticket", view: "ticket", label: "Export invoices as CSV" }]}
          activeTabID="ticket"
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
                state: state.change.state === "delivered" ? "done" : "in-progress",
                version: 1,
              },
              revisions: [
                {
                  id: productID,
                  ordinal: 1,
                  canonicalContent: JSON.stringify(planningProduct),
                  contentDigest: "b".repeat(64),
                  approvalId: "10000000-0000-4000-8000-000000000011",
                },
              ],
              documentRevisions: [],
              origin: null,
              followUps: [],
              technicalDesigns: [],
              technicalDesignPresent: false,
              implementationOrder: null,
            }}
            latestRevision={{
              id: productID,
              ordinal: 1,
              canonicalContent: JSON.stringify(planningProduct),
              contentDigest: "b".repeat(64),
              approvalId: "10000000-0000-4000-8000-000000000011",
            }}
            latestRequirement={planningProduct}
            change={{
              id: "10000000-0000-4000-8000-000000000010",
              baseSha: "a".repeat(40),
              branchName: "factory/synthetic-delivery",
              ...state.change,
            }}
            delivery={state.delivery}
            deliveryBlock={state.deliveryBlock}
            userID="10000000-0000-4000-8000-000000000009"
            storageKey="ticket-delivery:synthetic-user"
            ticketReference="BILL-24"
            pending={false}
            epics={[]}
            drafts={new Map<string, TicketDraft>()}
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
            onSaveDocument={async () => undefined}
            onConfirmRequirements={async () => undefined}
            clarificationAction={{ label: "Ask AI to clarify", status: false }}
            onFollowUp={run("follow-up")}
            onOpenTicket={noop}
            onOpenEpic={noop}
            onTrash={noop}
            onRestore={noop}
            onImplement={noop}
            onCodingOptions={noop}
            codingOptionsOpen={false}
            implementationAvailable
            onStopImplementation={noop}
            onOpenIDE={noop}
            onApproveDelivery={run("deliver")}
            onRetryReview={run("retry-review")}
            onRetryPromotion={run("retry-promotion")}
            onResumeChecks={run("resume-checks")}
            canDevelop={!state.contributor}
          />
        </div>
      </section>
      <output class="sr-only" aria-label="Fixture action">
        {action()}
      </output>
    </main>
  );
}
render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
