import type { Accessor, Setter, SourceAccessor } from "solid-js";
import type { PlanningIntent } from "#conversation-domain/conversation";
import type { EpicProposal } from "#conversation-domain/epic-proposal";
import type { CodingReasoning } from "#conversation-domain/model-settings";
import type { DeliveryBlock } from "#interface-domain/ticket-progress";
import type { RequirementContent } from "#requirement-domain/content";
import type { TechnicalDesignContent } from "#requirement-domain/technical-design";
import type { PrerequisiteView } from "#ticket-domain/dependency";
import type { FactoryZeroContext, FactoryZeroSchema } from "#zero-schema";
import type { useZero } from "#zero-solid";
import type { AgentView } from "../agent/contracts";
import type {
  Change,
  PersonalTicketDraft,
  RequirementRevision,
  Ticket,
  TicketDraft,
} from "../change/contracts";
import type { DeliveryView } from "../delivery/contracts";
import type { ActivityNavigationRequest } from "../ide-messages";
import type { InboxItem, InboxView } from "../inbox/contracts";
import type { InboxPosition } from "../inbox/navigation";
import type { createKnowledgeState } from "../knowledge/state";
import type { createProjectPlanning } from "../projects/planning";
import type { AppPreview, RuntimeAttempt, RuntimeDockTarget } from "../runtime/contracts";
import type { createWindowPresence } from "../window-presence";
import type { WorkspaceTab, WorkspaceView } from "../workspace-tabs";
import type { createBoardProjection } from "./board-projection";
import type { DesktopMutation, FactoryDesktopProps, TicketDetail } from "./contracts";
import type { ImplementationPreparation } from "./factory-agent-state";

type KnowledgePagesResult = NonNullable<
  ReturnType<ReturnType<typeof createKnowledgeState>["pages"]["data"]>
>;
type SelectedKnowledgePage = ReturnType<ReturnType<typeof createKnowledgeState>["page"]["data"]>;

export interface TicketSaveResult {
  id: string;
  ticketVersion: number;
  requirementRevisionId: string | null;
}

export interface DocumentWindowModel {
  workspaceElement: HTMLElement | undefined;
  workspaceView: () => WorkspaceView | undefined;
  workspaceWindow: ReturnType<typeof createWindowPresence>;
  workspaceVisible: SourceAccessor<boolean>;
  workspaceTabs: () => WorkspaceTab[];
  agentOverlay: () => boolean;
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  shareableURL: () => string | undefined;
  activateWorkspaceTab: (tab: WorkspaceTab) => void;
  closeWorkspaceTab: (tabID: string) => void;
  setWorkspaceVisible: (value: boolean) => void;
  inboxSourceActive: () => boolean;
  nextInboxItem: Accessor<InboxItem | undefined>;
  inboxSourceOpening: SourceAccessor<boolean>;
  inbox: {
    view: SourceAccessor<InboxView | undefined>;
    loading: SourceAccessor<boolean>;
    busy: SourceAccessor<boolean>;
    error: SourceAccessor<string>;
    refresh: () => Promise<void>;
    mark: (item: InboxItem, action: "read" | "unread" | "archive") => Promise<void>;
  };
  returnToInbox: (publish?: boolean) => void;
  startInboxItem: (item: InboxItem, ids?: readonly string[]) => Promise<void>;
  activeWorkspaceLabelID: () => string | undefined;
  epicProposals: SourceAccessor<Record<string, EpicProposal>>;
  bootstrap: FactoryDesktopProps;
  pending: () => boolean;
  confirmEpicWork: (entryID: string, proposal: EpicProposal) => Promise<boolean>;
  personalDrafts: Map<string, PersonalTicketDraft>;
  selectedProjectID: SourceAccessor<string | undefined>;
  publishTicketDraft: (
    draft: PersonalTicketDraft,
    state: "inbox" | "ready",
    projectID: string,
  ) => Promise<boolean>;
  updateWorkspaceTab: (tab: WorkspaceTab, key?: string | undefined) => void;
  detail: Accessor<TicketDetail | undefined>;
  inboxFeedbackID: SourceAccessor<string | undefined>;
  ticketDrafts: Map<string, TicketDraft>;
  confirmRequirements: (
    draft: TicketDraft,
    ticketID: string,
  ) => Promise<TicketSaveResult | undefined>;
  ticketClarificationAction: () => { label: string; status: boolean; question: boolean };
  selectedChange: Accessor<Change | undefined>;
  delivery: Accessor<DeliveryView | undefined>;
  latestRevision: () => RequirementRevision | undefined;
  latestRequirement: () => RequirementContent | undefined;
  agentTurnBusy: () => boolean;
  epicList: ReturnType<typeof createBoardProjection>["epicList"];
  prerequisitesFor: (ticketID: string) => PrerequisiteView[];
  dependencyCandidates: (ticketID: string) => Ticket[];
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  editDependency: (kind: "add" | "remove", prerequisiteId: string) => Promise<boolean>;
  assignTicketEpic: (epicId: string | null) => Promise<void>;
  beginRequirementsInterview: (intent?: PlanningIntent) => Promise<void>;
  saveTechnicalDesign: (revisionID: string, content: TechnicalDesignContent) => Promise<boolean>;
  assistantPending: () => boolean;
  assistantTicketID: () => string | undefined;
  saveTicketDocument: (
    input: TicketDraft,
    ticketID: string,
  ) => Promise<TicketSaveResult | undefined>;
  createFollowUp: () => Promise<void>;
  setSelectedEpicID: ReturnType<typeof createProjectPlanning>["setSelectedEpicID"];
  ticketTrashCommand: (ticketID: string, action: "trash" | "restore") => Promise<void>;
  implementTicket: (revisionID: string, codingReasoning?: CodingReasoning) => Promise<void>;
  preparingImplementation: () => ImplementationPreparation | undefined;
  openCodingOptions: (revisionID: string) => void;
  agentOpen: SourceAccessor<boolean>;
  modelRelayConfigured: SourceAccessor<boolean>;
  agent: Accessor<AgentView>;
  resumeCoding: () => Promise<void>;
  stopAgent: () => Promise<void>;
  ideTargets: () => RuntimeDockTarget[];
  openIDETarget: (target: RuntimeDockTarget) => Promise<void>;
  startPersonalIDE: () => Promise<void>;
  ticketPreviewTarget: (changeID: string | undefined) => RuntimeDockTarget | undefined;
  openPreviewTarget: (target: RuntimeDockTarget) => Promise<void>;
  retryMainPreview: (tab: WorkspaceTab) => Promise<void>;
  approveDelivery: (changeID: string) => Promise<void>;
  retryReview: (changeID: string) => Promise<void>;
  retryPromotion: (changeID: string) => Promise<void>;
  resumeChecks: (changeID: string) => Promise<void>;
  canDevelopProject: () => boolean;
  browserRepository: () => string | undefined;
  knowledgeDrafts: ReturnType<typeof createKnowledgeState>["drafts"];
  knowledgeLoading: ReturnType<typeof createKnowledgeState>["loading"];
  knowledgePageList: () => KnowledgePagesResult;
  selectedKnowledgePage: () => SelectedKnowledgePage;
  repositoryDocuments: ReturnType<typeof createKnowledgeState>["documents"];
  loadRepositoryDocuments: ReturnType<typeof createKnowledgeState>["loadDocuments"];
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
  deliveryBlockFor: (change: Change | undefined) => DeliveryBlock | undefined;
  projectMenuOpen: Accessor<boolean>;
  ideNavigation: SourceAccessor<ActivityNavigationRequest | undefined>;
  setIDENavigation: Setter<ActivityNavigationRequest | undefined>;
  setError: Setter<string>;
  refreshServerState: () => Promise<void>;
  openDevelopmentPreview: (attemptID: string, process: string, label: string) => void;
}

export function isSettingsTabActive(model: DocumentWindowModel, tabID: string): boolean {
  return model.workspaceView() === "settings" && model.activeWorkspaceTab()?.id === tabID;
}

export function activeIDETab(model: DocumentWindowModel): WorkspaceTab | undefined {
  const tab = model.activeWorkspaceTab();
  return tab?.view === "ide" ? tab : undefined;
}
