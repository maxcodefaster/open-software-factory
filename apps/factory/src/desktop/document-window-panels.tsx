import { Loading, lazy, Match, Show, Switch, untrack } from "solid-js";
import { zeroMutators } from "#zero-schema";
import type { Ticket } from "../change/contracts";
import { readPersonalTicketDraft } from "../change/drafts";
import { TicketAttentionControls } from "../inbox/ticket-people";
import { InboxWorkspace } from "../inbox/workspace";
import { ticketReference } from "../projects/ticket-content";
import { getKnowledgeSources, restoreKnowledgePage } from "../server-functions/knowledge";
import { serverCall } from "../server-functions/result";
import { cancelTicketImplementation } from "../server-functions/tickets";
import { EpicProposalWorkspace } from "../tickets/epic-proposal-workspace";
import { TicketDraftWorkspace } from "../tickets/ticket-draft-workspace";
import { TicketWorkspace } from "../tickets/ticket-workspace";
import { TrashWorkspace } from "../trash-workspace";
import type { DocumentWindowModel } from "./document-window-model";

const KnowledgeWorkspace = lazy(async () => ({
  default: (await import("../knowledge/knowledge-workspace")).KnowledgeWorkspace,
}));

export function DocumentWindowPanels(props: { model: DocumentWindowModel }) {
  const model = untrack(() => props.model);

  async function moveKnowledgePage(input: {
    pageId: string;
    parentId: string | null;
    beforeId: string | null;
  }) {
    const page = model.knowledgePageList().find((entry) => entry.id === input.pageId);
    const projectId = model.selectedProjectID();
    const client = model.zero();
    if (!page || !projectId || !client) throw new Error("Wiki page not found");
    await model.commitZeroMutation(
      client.mutate(
        zeroMutators.knowledge.move({
          projectId,
          pageId: input.pageId,
          parentId: input.parentId,
          beforeId: input.beforeId,
          expectedMetadataVersion: page.metadataVersion,
        }),
      ).server,
    );
  }

  async function updateKnowledgePageIcon(
    icon: "ticket" | "knowledge" | "home" | "ide" | "preview" | "settings",
  ) {
    const page = model.selectedKnowledgePage();
    const client = model.zero();
    if (!page || !client) throw new Error("Wiki page not found");
    await model.commitZeroMutation(
      client.mutate(
        zeroMutators.knowledge.setIcon({
          projectId: page.projectId,
          pageId: page.id,
          expectedMetadataVersion: page.metadataVersion,
          icon,
        }),
      ).server,
    );
  }

  return (
    <Loading
      on={model.activeWorkspaceTab()?.id}
      fallback={
        <p class="muted" role="status">
          Opening workspace…
        </p>
      }
    >
      <Switch>
        <Match
          when={model.workspaceView() === "epic-proposal" && model.activeWorkspaceTab()?.proposalID}
        >
          <Show when={model.epicProposals()[model.activeWorkspaceTab()?.proposalID ?? ""]} keyed>
            {(proposal) => (
              <EpicProposalWorkspace
                initial={proposal}
                storageKey={`epic-proposal:${model.bootstrap.session.user.id}:${model.activeWorkspaceTab()?.proposalID}`}
                pending={model.pending()}
                onConfirm={(value) =>
                  model.confirmEpicWork(model.activeWorkspaceTab()?.proposalID ?? "", value)
                }
              />
            )}
          </Show>
        </Match>
        <Match when={model.workspaceView() === "ticket-draft"}>
          <Show when={model.selectedProjectID()} keyed>
            {(projectID) => (
              <TicketDraftWorkspace
                storageKey={`ticket-draft:${model.bootstrap.session.user.id}:${projectID}`}
                initial={
                  model.personalDrafts.get(projectID) ??
                  readPersonalTicketDraft(
                    `ticket-draft:${model.bootstrap.session.user.id}:${projectID}`,
                  )
                }
                pending={model.pending()}
                onCreate={(draft, state) => model.publishTicketDraft(draft, state, projectID)}
                onChange={(draft) => {
                  model.personalDrafts.set(projectID, draft);
                  model.updateWorkspaceTab(
                    {
                      id: `ticket-draft:${projectID}`,
                      view: "ticket-draft",
                      label: draft.title || "New ticket",
                    },
                    projectID,
                  );
                }}
              />
            )}
          </Show>
        </Match>
        <Match when={model.workspaceView() === "ticket" ? model.detail() : undefined}>
          {(current) => (
            <TicketWorkspace
              projectID={current().ticket.projectId}
              people={
                <Show when={!current().ticket.trashedAt && !current().ticket.convertedToEpicId}>
                  <TicketAttentionControls
                    ticketID={current().ticket.id}
                    projectID={current().ticket.projectId}
                  />
                </Show>
              }
              feedbackID={model.inboxFeedbackID()}
              drafts={model.ticketDrafts}
              current={current()}
              storageKey={`ticket-edit:${model.bootstrap.session.user.id}:${current().ticket.id}`}
              onConfirmRequirements={model.confirmRequirements}
              clarificationAction={model.ticketClarificationAction()}
              awaitingAnswer={
                model.ticketClarificationAction().question &&
                model.assistantTicketID() === current().ticket.id
              }
              ticketReference={ticketReference(current().ticket.id)}
              change={model.selectedChange()}
              delivery={model.delivery()}
              deliveryBlock={model.deliveryBlockFor(model.selectedChange())}
              latestRevision={model.latestRevision()}
              latestRequirement={model.latestRequirement()}
              pending={model.pending()}
              buildInProgress={model.agentTurnBusy()}
              epics={model.epicList()}
              dependencies={{
                prerequisites: model.prerequisitesFor(current().ticket.id),
                candidates: model.dependencyCandidates(current().ticket.id),
                admitted: Boolean(model.selectedChange()),
                onOpen: model.selectTicket,
                onAdd: (id) => model.editDependency("add", id),
                onRemove: (id) => void model.editDependency("remove", id),
              }}
              onAssignEpic={(epicId) => void model.assignTicketEpic(epicId)}
              onInterview={() => void model.beginRequirementsInterview()}
              onFullPlanning={() => void model.beginRequirementsInterview("full-planning")}
              onTechnicalPlanning={() =>
                void model.beginRequirementsInterview("technical-planning")
              }
              onSaveTechnicalDesign={model.saveTechnicalDesign}
              planningBusy={
                model.assistantPending() && model.assistantTicketID() === current().ticket.id
              }
              onSaveDocument={model.saveTicketDocument}
              onFollowUp={() => void model.createFollowUp()}
              onOpenTicket={model.selectTicket}
              onOpenEpic={(id) => {
                model.setSelectedEpicID(id);
                model.setWorkspaceVisible(false);
              }}
              onTrash={() => void model.ticketTrashCommand(current().ticket.id, "trash")}
              onRestore={() => void model.ticketTrashCommand(current().ticket.id, "restore")}
              onImplement={(revisionID) =>
                void model.implementTicket(revisionID, model.preparingImplementation()?.reasoning)
              }
              onCodingOptions={model.openCodingOptions}
              codingOptionsOpen={Boolean(model.preparingImplementation() && model.agentOpen())}
              implementationAvailable={model.modelRelayConfigured()}
              codingPause={model.agent().codingPause}
              computeWait={model.agent().computeWait}
              onResumeCoding={() => void model.resumeCoding()}
              onStopImplementation={() => void model.stopAgent()}
              onCancelImplementation={() => {
                const order = current().implementationOrder;
                if (order)
                  void model.mutate(() =>
                    serverCall(
                      cancelTicketImplementation({
                        data: [current().ticket.id, order.commandId],
                      }),
                    ),
                  );
              }}
              onOpenIDE={() => {
                const target = model
                  .ideTargets()
                  .find((candidate) => candidate.changeId === model.selectedChange()?.id);
                if (target) void model.openIDETarget(target);
              }}
              onOpenPreview={
                model.selectedChange() && model.ticketPreviewTarget(model.selectedChange()?.id)
                  ? () => {
                      const target = model.ticketPreviewTarget(model.selectedChange()?.id);
                      if (target) void model.openPreviewTarget(target);
                    }
                  : undefined
              }
              active={model.workspaceVisible() && model.workspaceView() === "ticket"}
              onApproveDelivery={(changeID) => void model.approveDelivery(changeID)}
              onRetryReview={(changeID) => void model.retryReview(changeID)}
              onRetryPromotion={(changeID) => void model.retryPromotion(changeID)}
              onResumeChecks={(changeID) => void model.resumeChecks(changeID)}
              canDevelop={model.canDevelopProject()}
              userID={model.bootstrap.session.user.id}
            />
          )}
        </Match>
        <Match when={model.workspaceView() === "knowledge"}>
          <KnowledgeWorkspace
            projectID={model.selectedProjectID() ?? ""}
            userID={model.bootstrap.session.user.id}
            repositoryURL={model.browserRepository() ?? ""}
            canDevelop={model.canDevelopProject()}
            onOpenIDE={() => {
              const target = model.ideTargets().find((entry) => !entry.changeId);
              if (target) void model.openIDETarget(target);
            }}
            onRestore={(pageID, revisionID, expectedVersion) =>
              serverCall(restoreKnowledgePage({ data: [pageID, revisionID, expectedVersion] }))
            }
            drafts={model.knowledgeDrafts}
            pages={model.knowledgePageList()}
            loading={model.knowledgeLoading()}
            selectedPage={model.selectedKnowledgePage()}
            documents={model.repositoryDocuments()}
            openDocument={model.openRepositoryDocument()}
            generation={model.knowledgeGeneration()}
            revisions={model.knowledgeHistory()}
            searchResults={model.knowledgeSearch()}
            searchQuery={model.knowledgeSearchQuery()}
            pending={model.pending()}
            onSelectPage={model.selectKnowledgePage}
            onOpenDocument={(path) => void model.openDocument(path)}
            onLoadDocuments={model.loadRepositoryDocuments}
            onGenerate={() => void model.mutate(model.generateKnowledge)}
            onSearch={(query) => model.searchProjectKnowledge(query)}
            onSavePage={model.editKnowledgePage}
            onHistory={model.loadKnowledgeHistory}
            onSources={async (pageID) =>
              (await serverCall(getKnowledgeSources({ data: [pageID] }))).citations
            }
            onArchive={() => void model.archiveKnowledgePage()}
            onMove={moveKnowledgePage}
            onIcon={updateKnowledgePageIcon}
          />
        </Match>
        <Match when={model.workspaceView() === "inbox"}>
          <InboxWorkspace
            position={model.inboxPosition()}
            restoreKey={model.inboxRestoreKey()}
            onPosition={(patch) =>
              model.setInboxPosition((position) => ({ ...position, ...patch }))
            }
            view={model.inbox.view()}
            loading={model.inbox.loading()}
            error={model.inbox.error()}
            busy={model.inbox.busy()}
            onRefresh={() => void model.inbox.refresh()}
            onOpen={(item, queue) => void model.startInboxItem(item, queue)}
            onMark={(item, action) => model.inbox.mark(item, action)}
          />
        </Match>
        <Match when={model.workspaceView() === "trash"}>
          <TrashWorkspace
            tickets={
              (model.trashTickets.data() as Ticket[] | undefined)?.slice(0, model.trashLimit()) ??
              []
            }
            pending={model.pending()}
            onOpen={model.selectTicket}
            onRestore={(id) => void model.ticketTrashCommand(id, "restore")}
            onRetry={(id) => void model.ticketTrashCommand(id, "trash")}
            hasMore={(model.trashTickets.data()?.length ?? 0) > model.trashLimit()}
            onShowMore={() => model.setTrashLimit((limit) => limit + 50)}
          />
        </Match>
      </Switch>
    </Loading>
  );
}
