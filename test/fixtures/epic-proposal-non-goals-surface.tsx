import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { EpicProposalWorkspace } from "../../apps/factory/src/epic-proposal-workspace";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import type { EpicProposal } from "../../packages/conversation-domain/src/epic-proposal";
import { epicNonGoalsKey, epicNonGoalsProposal } from "./epic-proposal-non-goals";
import { fixtureValue } from "./value";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

const query = new URLSearchParams(location.search);
const initial = epicNonGoalsProposal();
if (query.has("empty")) for (const member of initial.members) member.requirement.nonGoals = [];
const storageKey = `${epicNonGoalsKey}${query.has("other") ? ":other" : ""}`;
const noop = () => {};
function Surface() {
  const [submitted, setSubmitted] = createSignal<EpicProposal>();
  const [confirmations, setConfirmations] = createSignal(0);
  return (
    <main class="factory-desktop" data-background="river-landscape">
      <header class="factory-topbar">
        <span class="context-button">Proposed Epic · Isolated fixture</span>
      </header>
      <section class="workspace-window" aria-label="Epic workspace">
        <WorkspaceTabbar
          tabs={[{ id: "proposal", view: "epic-proposal", label: "Proposed Epic" }]}
          activeTabID="proposal"
          onActivate={noop}
          onClose={noop}
          onMinimize={noop}
        />
        <div class="workspace-view-body">
          <EpicProposalWorkspace
            id="isolated-non-goals"
            initial={initial}
            storageKey={storageKey}
            pending={false}
            onConfirm={async (proposal) => {
              setSubmitted(proposal);
              setConfirmations((count) => count + 1);
              return query.has("accept");
            }}
          />
        </div>
      </section>
      <output hidden aria-label="Fixture confirmations">
        {confirmations()}
      </output>
      <output hidden aria-label="Submitted Epic proposal">
        {JSON.stringify(submitted())}
      </output>
    </main>
  );
}
render(() => <Surface />, fixtureValue(document.getElementById("root"), "fixture root"));
