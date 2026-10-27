import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { For, Loading, lazy, Match, Show, Switch, untrack } from "solid-js";
import type { PlanningIntent } from "../../../../packages/conversation-domain/src/conversation";
import type { EpicProposal } from "../../../../packages/conversation-domain/src/epic-proposal";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import type { TechnicalDesignContent } from "../../../../packages/requirement-domain/src/technical-design";
import type { PrerequisiteView } from "../../../../packages/ticket-domain/src/dependency";
import {
  type FactoryZeroContext,
  type FactoryZeroSchema,
  zeroMutators,
} from "../../../../packages/zero-schema/src";
import type { useZero } from "../../../../packages/zero-solid/src";
import type {
  AgentView,
  AppPreview,
  Change,
  DeliveryView,
  RuntimeAttempt,
  RuntimeDockTarget,
  Ticket,
} from "../api-contracts";
import { EpicProposalWorkspace } from "../epic-proposal-workspace";
import type { ActivityNavigationRequest } from "../ide-messages";
import type { InboxItem } from "../inbox/contracts";
import type { InboxPosition } from "../inbox/navigation";
import { InboxSourceNavigation } from "../inbox/source-navigation";
import { TicketAttentionControls } from "../inbox/ticket-people";
import type { createKnowledgeState } from "../knowledge/state";
import type { createProjectPlanning } from "../projects/planning";
import { ticketReference } from "../projects/ticket-content";
import { getKnowledgeSources, restoreKnowledgePage } from "../server-functions/knowledge";
import { serverCall } from "../server-functions/result";
import { cancelTicketImplementation } from "../server-functions/tickets";
import {
  type PersonalTicketDraft,
  readPersonalTicketDraft,
  TicketDraftWorkspace,
} from "../ticket-draft-workspace";
import type { TicketDraft } from "../ticket-workspace";
import { TicketWorkspace } from "../ticket-workspace";
import { TrashWorkspace } from "../trash-workspace";
import type { createWindowPresence } from "../window-presence";
import { InboxWorkspace } from "../workspace-chrome";
import { WorkspaceTabbar, workspacePanelID } from "../workspace-tabbar";
import type { WorkspaceTab, WorkspaceView } from "../workspace-tabs";
import type { DesktopMutation, FactoryDesktopProps, TicketDetail } from "./contracts";

const KnowledgeWorkspace = lazy(async () => ({
  default: (await import("../knowledge-workspace")).KnowledgeWorkspace,
}));
const RuntimeWorkspaceTabs = lazy(async () => ({
  default: (await import("../runtime-workspace")).RuntimeWorkspaceTabs,
}));
const DeveloperIDEWorkspace = lazy(async () => ({
  default: (await import("../developer-ide-workspace")).DeveloperIDEWorkspace,
}));
const SettingsWorkspace = lazy(async () => ({
  default: (await import("../settings-workspace")).SettingsWorkspace,
}));
export interface DocumentWindowModel {
  workspaceElement: HTMLElement | undefined;
  workspaceView: () => WorkspaceView | undefined;
  workspaceWindow: ReturnType<typeof createWindowPresence>;
  workspaceVisible: SourceAccessor<boolean>;
  workspaceTabs: () => WorkspaceTab[];
  agentOverlay: () => boolean;
  registrationOpen: SourceAccessor<boolean>;
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  shareableURL: () => string | undefined;
  activateWorkspaceTab: (tab: WorkspaceTab) => void;
  closeWorkspaceTab: (tabID: string) => void;
  setWorkspaceVisible: (value: boolean) => void;
  inboxSourceActive: () => boolean;
  nextInboxItem: Accessor<InboxItem | undefined>;
  inboxSourceOpening: SourceAccessor<boolean>;
  inbox: {
    view: SourceAccessor<
      | {
          items: {
            id: string;
            eventId: string;
            projectId: string;
            projectName: string;
            ticketId: string | null;
            ticketTitle: string;
            title: string;
            preview: string;
            createdAt: string;
            needsAction: boolean;
            unread: boolean;
            archived: boolean;
            updates: number;
            target: "ticket" | "conversation" | "review" | "coding" | "inputs";
            targetId: string | null;
            contextId: string | null;
          }[];
          count: number;
        }
      | undefined
    >;
    loading: SourceAccessor<boolean>;
    busy: SourceAccessor<boolean>;
    error: SourceAccessor<string>;
    refresh: () => Promise<void>;
    mark: (item: InboxItem, action: "read" | "unread" | "archive") => Promise<void>;
  };
  returnToInbox: (publish?: boolean) => void;
  startInboxItem: (item: InboxItem, ids?: readonly string[]) => Promise<void>;
  activeWorkspaceLabelID: () => string | undefined;
  epicProposals: SourceAccessor<
    Record<
      string,
      {
        epic: { title: string; description: string };
        members: {
          requirement: { summary: string; acceptanceCriteria: string[]; nonGoals: string[] };
          dependsOn: string[];
          title: string;
          description: string;
          key: string;
          existingTicketId: string | null;
          expectedVersion: number | null;
        }[];
      }
    >
  >;
  bootstrap: FactoryDesktopProps;
  pending: () => boolean;
  confirmEpicWork: (entryID: string, proposal: EpicProposal) => Promise<boolean>;
  personalDraftKey: () => string;
  personalDrafts: Map<
    string,
    {
      id: string;
      title: string;
      description: string;
      stage?: "inbox" | "ready" | undefined;
      attachmentSequence?: number | undefined;
    }
  >;
  selectedProjectID: SourceAccessor<string | undefined>;
  publishTicketDraft: (draft: PersonalTicketDraft, state: "inbox" | "ready") => Promise<boolean>;
  updateWorkspaceTab: (tab: WorkspaceTab, key?: string | undefined) => void;
  detail: Accessor<TicketDetail | undefined>;
  inboxFeedbackID: SourceAccessor<string | undefined>;
  ticketDrafts: Map<string, TicketDraft>;
  confirmRequirements: (
    draft: TicketDraft,
  ) => Promise<
    { id: string; ticketVersion: number; requirementRevisionId: string | null } | undefined
  >;
  ticketClarificationAction: () => { label: string; status: boolean };
  selectedChange: Accessor<Change | undefined>;
  delivery: Accessor<DeliveryView | undefined>;
  latestRevision: () =>
    | {
        id: string;
        ordinal: number;
        canonicalContent: string;
        contentDigest: string;
        createdAt?: string | undefined;
        approvalId?: string | undefined;
        approvedAt?: string | undefined;
        monitoringIncidentId?: string | undefined;
        author?: string | undefined;
        authorKind?: "human" | "ai" | undefined;
      }
    | undefined;
  latestRequirement: () =>
    | { summary: string; acceptanceCriteria: string[]; nonGoals: string[] }
    | undefined;
  agentTurnBusy: () => boolean;
  epicList: () => {
    readonly id: string;
    readonly projectId: string;
    readonly parentId: string | null;
    readonly title: string;
    readonly description: string;
    readonly version: number;
    readonly createdBy: string;
    readonly createdAt: number;
    readonly updatedAt: number;
  }[];
  prerequisitesFor: (ticketID: string) => PrerequisiteView[];
  dependencyCandidates: (ticketID: string) => Ticket[];
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  editDependency: (kind: "add" | "remove", prerequisiteId: string) => Promise<boolean>;
  assignTicketEpic: (epicId: string | null) => Promise<void>;
  beginRequirementsInterview: (intent?: PlanningIntent) => Promise<void>;
  saveTechnicalDesign: (revisionID: string, content: TechnicalDesignContent) => Promise<boolean>;
  assistantPending: () => boolean;
  assistantTicketID: () => string | undefined;
  moveTicket: (ticket: Ticket, state: "inbox" | "ready") => Promise<boolean>;
  saveTicketDocument: (
    input: TicketDraft,
  ) => Promise<
    { id: string; ticketVersion: number; requirementRevisionId: string | null } | undefined
  >;
  createFollowUp: () => Promise<void>;
  setSelectedEpicID: ReturnType<typeof createProjectPlanning>["setSelectedEpicID"];
  ticketTrashCommand: (ticketID: string, action: "trash" | "restore") => Promise<void>;
  implementTicket: (revisionID: string, codingReasoning?: CodingReasoning) => Promise<void>;
  preparingImplementation: () =>
    | {
        projectID: string;
        ticketID: string;
        revisionID: string;
        reasoning: CodingReasoning | undefined;
        failure: string | undefined;
      }
    | undefined;
  openCodingOptions: (revisionID: string) => void;
  agentOpen: SourceAccessor<boolean>;
  modelRelayConfigured: SourceAccessor<boolean>;
  agent: Accessor<AgentView>;
  resumeCoding: () => Promise<void>;
  stopAgent: () => Promise<void>;
  ideTargets: () => RuntimeDockTarget[];
  openIDETarget: (target: RuntimeDockTarget) => Promise<void>;
  ticketPreviewTarget: (changeID: string | undefined) => RuntimeDockTarget | undefined;
  openPreviewTarget: (target: RuntimeDockTarget) => Promise<void>;
  approveDelivery: (changeID: string) => Promise<void>;
  retryReview: (changeID: string) => Promise<void>;
  resumeChecks: (changeID: string) => Promise<void>;
  canDevelopProject: () => boolean;
  browserRepository: () => string | undefined;
  knowledgeDrafts: ReturnType<typeof createKnowledgeState>["drafts"];
  knowledgePageList: () => {
    readonly id: string;
    readonly projectId: string;
    readonly slug: string;
    readonly title: string;
    readonly parentId: string | null;
    readonly sortOrder: number;
    readonly icon: "ticket" | "knowledge" | "home" | "ide" | "preview" | "settings";
    readonly metadataVersion: number;
    readonly state: "active" | "archived";
    readonly version: number;
    readonly currentRevisionId: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
  }[];
  selectedKnowledgePage: () =>
    | {
        readonly id: string;
        readonly projectId: string;
        readonly slug: string;
        readonly title: string;
        readonly parentId: string | null;
        readonly sortOrder: number;
        readonly icon: "ticket" | "knowledge" | "home" | "ide" | "preview" | "settings";
        readonly metadataVersion: number;
        readonly state: "active" | "archived";
        readonly version: number;
        readonly currentBody: string;
        readonly currentRevisionId: string | null;
        readonly createdAt: number;
        readonly updatedAt: number;
      }
    | undefined;
  repositoryDocuments: ReturnType<typeof createKnowledgeState>["documents"];
  openRepositoryDocument: ReturnType<typeof createKnowledgeState>["document"];
  knowledgeGeneration: ReturnType<typeof createKnowledgeState>["generation"];
  knowledgeHistory: ReturnType<typeof createKnowledgeState>["history"];
  knowledgeSearch: ReturnType<typeof createKnowledgeState>["results"];
  knowledgeSearchQuery: ReturnType<typeof createKnowledgeState>["query"];
  selectKnowledgePage: (pageID: string) => void;
  openDocument: (path: string) => Promise<void>;
  mutate: DesktopMutation;
  generateKnowledge: ReturnType<typeof createKnowledgeState>["generate"];
  searchProjectKnowledge: ReturnType<typeof createKnowledgeState>["search"];
  editKnowledgePage: ReturnType<typeof createKnowledgeState>["save"];
  loadKnowledgeHistory: ReturnType<typeof createKnowledgeState>["loadHistory"];
  archiveKnowledgePage: () => Promise<void>;
  zero: ReturnType<typeof useZero<FactoryZeroSchema, undefined, FactoryZeroContext>>;
  commitZeroMutation: (operation: Promise<unknown>) => Promise<void>;
  inboxPosition: SourceAccessor<InboxPosition>;
  inboxRestoreKey: SourceAccessor<number>;
  setInboxPosition: Setter<InboxPosition>;
  trashTickets: ReturnType<typeof createProjectPlanning>["tickets"];
  trashLimit: ReturnType<typeof createProjectPlanning>["trashLimit"];
  setTrashLimit: ReturnType<typeof createProjectPlanning>["setTrashLimit"];
  canManageSettingsProject: (projectID: string | undefined) => boolean;
  refreshModelAvailability: () => Promise<void>;
  selectProject: (projectID: string, fromInbox?: boolean, publish?: boolean) => void;
  memberships: ReturnType<typeof createProjectPlanning>["memberships"];
  attempts: Accessor<RuntimeAttempt[]>;
  appPreviews: Accessor<AppPreview[]>;
  changes: Accessor<Change[]>;
  projectMenuOpen: ReturnType<typeof createProjectPlanning>["projectMenuOpen"];
  ideNavigation: SourceAccessor<ActivityNavigationRequest | undefined>;
  setIDENavigation: Setter<ActivityNavigationRequest | undefined>;
  setError: Setter<string>;
  refreshServerState: () => Promise<void>;
  openDevelopmentPreview: (attemptID: string, process: string, label: string) => void;
}

export function DocumentWindow(props: { model: DocumentWindowModel }) {
  // The model identity is stable; its accessors retain live state.
  const model = untrack(() => props.model);
  return (
    <section
      ref={model.workspaceElement}
      class={`workspace-window workspace-window-${model.workspaceView() ?? "minimized"}`}
      aria-label={`${model.workspaceView() ?? "minimized"} workspace`}
      data-closing={model.workspaceWindow.closing() ? "true" : "false"}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "window-out")
          model.workspaceWindow.finishExit();
      }}
      aria-hidden={model.workspaceVisible() ? "false" : "true"}
      hidden={!model.workspaceWindow.present() || model.workspaceTabs().length === 0}
      inert={!model.workspaceVisible() || model.agentOverlay() || model.registrationOpen()}
    >
      <WorkspaceTabbar
        tabs={model.workspaceTabs()}
        activeTabID={model.activeWorkspaceTab()?.id}
        shareURL={model.shareableURL()}
        onActivate={model.activateWorkspaceTab}
        onClose={model.closeWorkspaceTab}
        onMinimize={() => model.setWorkspaceVisible(false)}
      />
      <Show when={model.inboxSourceActive() && !model.agentOverlay()}>
        <InboxSourceNavigation
          next={model.nextInboxItem()}
          busy={model.inboxSourceOpening() || model.inbox.busy()}
          onBack={model.returnToInbox}
          onNext={() => {
            const item = model.nextInboxItem();
            if (item) void model.startInboxItem(item);
          }}
        />
      </Show>
      <div
        class="workspace-view-body"
        role="tabpanel"
        id={workspacePanelID}
        aria-labelledby={model.activeWorkspaceLabelID()}
        tabindex="-1"
      >
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
              when={
                model.workspaceView() === "epic-proposal" && model.activeWorkspaceTab()?.proposalID
              }
            >
              <Show
                when={model.epicProposals()[model.activeWorkspaceTab()?.proposalID ?? ""]}
                keyed
              >
                {(proposal) => (
                  <EpicProposalWorkspace
                    id={model.activeWorkspaceTab()?.proposalID ?? ""}
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
              <TicketDraftWorkspace
                storageKey={model.personalDraftKey()}
                initial={
                  model.personalDrafts.get(model.selectedProjectID() ?? "") ??
                  readPersonalTicketDraft(model.personalDraftKey())
                }
                pending={model.pending()}
                onCreate={model.publishTicketDraft}
                onChange={(draft) => {
                  const projectID = model.selectedProjectID();
                  if (projectID) model.personalDrafts.set(projectID, draft);
                  model.updateWorkspaceTab({
                    id: `ticket-draft:${projectID}`,
                    view: "ticket-draft",
                    label: draft.title || "New ticket",
                  });
                }}
              />
            </Match>
            <Match when={model.workspaceView() === "ticket" && model.detail()}>
              <Show when={model.detail()}>
                {(current) => (
                  <TicketWorkspace
                    projectID={current().ticket.projectId}
                    people={
                      <Show
                        when={!current().ticket.trashedAt && !current().ticket.convertedToEpicId}
                      >
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
                    ticketReference={ticketReference(current().ticket.id)}
                    change={model.selectedChange()}
                    delivery={model.delivery()}
                    latestRevision={model.latestRevision()}
                    latestRequirement={model.latestRequirement()}
                    pending={model.pending()}
                    buildInProgress={model.agentTurnBusy()}
                    epics={model.epicList()}
                    dependencies={{
                      prerequisites: model.prerequisitesFor(current().ticket.id),
                      candidates: model.dependencyCandidates(current().ticket.id),
                      admitted: Boolean(model.selectedChange()),
                      pending: model.pending(),
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
                    onWriteRequirements={() => void model.moveTicket(current().ticket, "ready")}
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
                      void model.implementTicket(
                        revisionID,
                        model.preparingImplementation()?.reasoning,
                      )
                    }
                    onCodingOptions={model.openCodingOptions}
                    codingOptionsOpen={Boolean(
                      model.preparingImplementation() && model.agentOpen(),
                    )}
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
                      const target = props.model
                        .ideTargets()
                        .find((candidate) => candidate.changeId === model.selectedChange()?.id);
                      if (target) void model.openIDETarget(target);
                    }}
                    onOpenPreview={
                      model.selectedChange() &&
                      model.ticketPreviewTarget(model.selectedChange()?.id)
                        ? () => {
                            const target = model.ticketPreviewTarget(model.selectedChange()?.id);
                            if (target) void model.openPreviewTarget(target);
                          }
                        : undefined
                    }
                    active={model.workspaceVisible() && model.workspaceView() === "ticket"}
                    onApproveDelivery={(changeID) => void model.approveDelivery(changeID)}
                    onRetryReview={(changeID) => void model.retryReview(changeID)}
                    onResumeChecks={(changeID) => void model.resumeChecks(changeID)}
                    canDevelop={model.canDevelopProject()}
                    userID={model.bootstrap.session.user.id}
                  />
                )}
              </Show>
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
                onGenerate={() => void model.mutate(model.generateKnowledge)}
                onSearch={(query) => void model.searchProjectKnowledge(query)}
                onSavePage={model.editKnowledgePage}
                onHistory={model.loadKnowledgeHistory}
                onSources={async (pageID) =>
                  (await serverCall(getKnowledgeSources({ data: [pageID] }))).citations
                }
                onArchive={() => void model.archiveKnowledgePage()}
                onMove={async ({ pageId, parentId, beforeId }) => {
                  const page = model.knowledgePageList().find((entry) => entry.id === pageId);
                  const projectId = model.selectedProjectID();
                  const client = model.zero();
                  if (!page || !projectId || !client) throw new Error("Wiki page not found");
                  await model.commitZeroMutation(
                    client.mutate(
                      zeroMutators.knowledge.move({
                        projectId,
                        pageId,
                        parentId,
                        beforeId,
                        expectedMetadataVersion: page.metadataVersion,
                      }),
                    ).server,
                  );
                }}
                onIcon={async (icon) => {
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
                }}
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
                  (model.trashTickets.data() as Ticket[] | undefined)?.slice(
                    0,
                    model.trashLimit(),
                  ) ?? []
                }
                pending={model.pending()}
                onOpen={model.selectTicket}
                onRestore={(id) => void model.ticketTrashCommand(id, "restore")}
                onRetry={(id) => void model.ticketTrashCommand(id, "trash")}
              />
              <Show when={(model.trashTickets.data()?.length ?? 0) > model.trashLimit()}>
                <button
                  type="button"
                  class="quiet-button"
                  onClick={() => model.setTrashLimit((limit) => limit + 50)}
                >
                  Show more removed Tickets
                </button>
              </Show>
            </Match>
          </Switch>
        </Loading>
        <For
          each={model.workspaceTabs().filter((tab) => tab.view === "settings")}
          keyed={(tab) => tab.id}
        >
          {(tab) => (
            <div
              class="settings-tab-panel"
              hidden={
                model.workspaceView() !== "settings" || model.activeWorkspaceTab()?.id !== tab().id
              }
            >
              <SettingsWorkspace
                active={
                  model.workspaceView() === "settings" &&
                  model.activeWorkspaceTab()?.id === tab().id
                }
                userID={model.bootstrap.session.user.id}
                initialSelection={tab().settingsSelection}
                project={tab().settingsProject}
                systemManager={model.bootstrap.session.systemManager}
                projectManager={model.canManageSettingsProject(tab().settingsProject?.id)}
                onModelsChanged={model.refreshModelAvailability}
                onOpenTicket={(ticketID, projectID) => {
                  if (model.selectedProjectID() !== projectID) model.selectProject(projectID);
                  model.selectTicket(ticketID);
                }}
                developer={
                  model.bootstrap.session.systemManager ||
                  model.memberships
                    .data()
                    ?.some(
                      (member) =>
                        member.projectId === tab().settingsProject?.id &&
                        member.role === "developer",
                    ) === true
                }
              />
            </div>
          )}
        </For>
        <RuntimeWorkspaceTabs
          projectID={model.selectedProjectID() ?? ""}
          tabs={model.workspaceTabs()}
          activeTabID={model.workspaceVisible() ? model.activeWorkspaceTab()?.id : undefined}
          attempts={model.attempts()}
          previews={model.appPreviews()}
          pending={model.pending()}
          userID={model.bootstrap.session.user.id}
          canDevelop={model.canDevelopProject()}
          onOpenTicket={(changeID) => {
            const change = props.model
              .changes()
              .find(
                (candidate) =>
                  candidate.id === changeID && candidate.projectId === model.selectedProjectID(),
              );
            if (change) model.selectTicket(change.ticketId);
          }}
        />
        <DeveloperIDEWorkspace
          userID={model.bootstrap.session.user.id}
          projectID={model.selectedProjectID()}
          allowed={model.canDevelopProject()}
          preparingSelection={model.projectMenuOpen()}
          workspaceID={
            model.activeWorkspaceTab()?.view === "ide"
              ? model.activeWorkspaceTab()?.workspaceID
              : undefined
          }
          active={model.workspaceView() === "ide"}
          navigation={model.ideNavigation()}
          onNavigationOutcome={(id, error) => {
            if (model.ideNavigation()?.id !== id) return;
            model.setIDENavigation(undefined);
            if (error) model.setError(error);
          }}
          onDevelopmentPreview={(message) => {
            const projectID = model.selectedProjectID();
            void props.model
              .refreshServerState()
              .then(() => {
                if (model.selectedProjectID() !== projectID) return;
                if (
                  props.model
                    .attempts()
                    .some(
                      (attempt) =>
                        attempt.id === message.attemptID &&
                        attempt.workspaceId === message.workspaceID,
                    )
                )
                  model.openDevelopmentPreview(message.attemptID, message.process, message.label);
              })
              .catch((cause: unknown) =>
                model.setError(cause instanceof Error ? cause.message : "Preview is unavailable."),
              );
          }}
        />
      </div>
    </section>
  );
}
