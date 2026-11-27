import type { Accessor, Setter, SourceAccessor } from "solid-js";
import type { ConversationMode, InterviewQuestion } from "#conversation-domain/conversation";
import type { CodingReasoning } from "#conversation-domain/model-settings";
import type { PrerequisiteView } from "#ticket-domain/dependency";
import type { AgentMessage, AgentView, WriterView } from "../agent/contracts";
import type { Change, PersonalTicketDraft, Ticket } from "../change/contracts";
import type { ConversationDisplayItem } from "../conversation-activity";
import type { InboxItem } from "../inbox/contracts";
import type { createKnowledgeState } from "../knowledge/state";
import type { ConversationView } from "../project-agent/contracts";
import type { createProjectPlanning } from "../projects/planning";
import type { createProjectSetupInteraction } from "../setup/panel";
import type { createWindowPresence } from "../window-presence";
import type { WorkspaceTab, WorkspaceView } from "../workspace-tabs";
import type { DesktopProject, FactoryDesktopProps, TicketDetail } from "./contracts";

export interface AssistantImplementationPreparation {
  projectID: string;
  ticketID: string;
  revisionID: string;
  reasoning: CodingReasoning | undefined;
  failure: string | undefined;
}

export interface AssistantRevisionSummary {
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

export interface AssistantInterviewQuestionEntry {
  id: string;
  ordinal: number;
  kind: "requirement" | "user-message" | "agent-message" | "question" | "answer" | "mode-change";
  actor: "user" | "change-agent" | "project-agent" | "system";
  mode: "investigate" | "plan" | "build";
  body: string;
  payload: Record<string, unknown>;
  citations: {
    source: "ticket" | "epic" | "knowledge" | "code" | "attachment";
    id: string;
    label: string;
    reference?: number | undefined;
    commitSha?: string | undefined;
    path?: string | undefined;
  }[];
  createdAt: string;
  inReplyToEntryId?: string | undefined;
  requirementRevisionId?: string | undefined;
}

export interface AssistantEpicProposal {
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

export type AssistantConversationPlaceholder =
  | "Clarify this Ticket's requirements…"
  | "Describe the change you want to plan…"
  | "Ask about this Ticket…"
  | "Ask about this Project…";

export interface AssistantPanelModel {
  agentPresence: ReturnType<typeof createWindowPresence>;
  agentOpen: SourceAccessor<boolean>;
  agentOverlay: () => boolean;
  agentPanelElement: HTMLElement | undefined;
  inboxSourceActive: () => boolean;
  nextInboxItem: Accessor<InboxItem | undefined>;
  inboxSourceOpening: SourceAccessor<boolean>;
  inboxBusy: Accessor<boolean>;
  returnToInbox: (publish?: boolean) => void;
  startInboxItem: (item: InboxItem, ids?: readonly string[]) => Promise<void>;
  setupVisible: () => boolean;
  preparingImplementation: () => AssistantImplementationPreparation | undefined;
  detail: Accessor<TicketDetail | undefined>;
  dismissAgent: () => void;
  projectSetup: ReturnType<typeof createProjectSetupInteraction> | undefined;
  openSettings: () => void;
  selectProject: (projectID: string, fromInbox?: boolean, publish?: boolean) => void;
  conversationScope: () => string;
  assistantTicketID: () => string | undefined;
  ticketList: () => Ticket[];
  selectedProject: Accessor<DesktopProject | undefined>;
  conversation: Accessor<ConversationView | undefined>;
  canDevelopProject: () => boolean;
  conversationMode: () => ConversationMode;
  assistantPending: () => boolean;
  assistantContextLoading: () => boolean;
  codingWriterBlocked: () => boolean;
  agentViewLoaded: () => boolean;
  agentCanRun: () => boolean;
  agentTurnBusy: () => boolean;
  agent: Accessor<AgentView>;
  agentNeedsResolution: () => boolean;
  setConversationSelections: Setter<Record<string, string>>;
  newConversation: (coding: boolean) => Promise<void>;
  setImplementationPreparation: Setter<AssistantImplementationPreparation | undefined>;
  selectedChange: Accessor<Change | undefined>;
  ticketWorkspaceReady: () => boolean;
  ticketWorkspaceStatus: () => string;
  pending: () => boolean;
  recheckStopConfirmation: () => Promise<void>;
  checkStopStatus: () => Promise<void>;
  conversationScroll: { reset(): void; dispose(): void } | undefined;
  visibleConversation: Accessor<
    ConversationDisplayItem<ConversationView["entries"][number], AgentMessage>[]
  >;
  openChatActivity: (message: AgentMessage, kind: "file" | "diff") => Promise<void>;
  answeredQuestionIDs: () => Map<string, string>;
  answerSummary: (questionID: string) => string | undefined;
  latestRevision: () => AssistantRevisionSummary | undefined;
  workspaceView: () => WorkspaceView | undefined;
  restoredInterviewAnswer: (
    questionEntryID: string,
  ) => { selectedOptionIds: string[]; customText: string } | undefined;
  bootstrap: FactoryDesktopProps;
  pendingInterview: () => boolean;
  currentInterviewQuestion: SourceAccessor<AssistantInterviewQuestionEntry | undefined>;
  pauseClarification: (value: boolean) => void;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  answerInterview: (
    event: SubmitEvent,
    questionEntryID: string,
    question: InterviewQuestion,
  ) => Promise<void>;
  epicProposals: SourceAccessor<Record<string, AssistantEpicProposal>>;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  setError: Setter<string>;
  openTicketDraft: (proposed?: PersonalTicketDraft, stage?: "inbox" | "ready") => void;
  setSelectedEpicID: ReturnType<typeof createProjectPlanning>["setSelectedEpicID"];
  browserRepository: () => string | undefined;
  selectKnowledgePage: (pageID: string) => void;
  openKnowledge: ReturnType<typeof createKnowledgeState>["open"];
  streamedAnswer: () => { turnId: string; text: string } | undefined;
  setCodingWriter: Setter<{ changeID: string; view: WriterView | undefined } | undefined>;
  historicalCoding: () => boolean;
  retainedCodingDraft: () => string;
  assistantKey: () => string;
  selectedProjectID: SourceAccessor<string | undefined>;
  stopAgent: () => Promise<void>;
  restoredMessageScope: SourceAccessor<string | undefined>;
  agentCommandScope: (
    kind: string,
    identity?: string | null | undefined,
    projectID?: string | undefined,
  ) => string;
  implementTicket: (revisionID: string, codingReasoning?: CodingReasoning) => Promise<void>;
  canPromptBuild: () => boolean;
  startAgent: () => Promise<void>;
  promptAgent: (event: SubmitEvent) => Promise<void>;
  restoreMessageDraft: (element: HTMLTextAreaElement, scope: () => string) => void;
  chosenCodingReasoning: () => "max" | "medium" | "high" | "xhigh" | undefined;
  setCodingReasoningChoices: Setter<
    Record<string, "max" | "medium" | "high" | "xhigh" | undefined>
  >;
  modelRelayConfigured: SourceAccessor<boolean>;
  blockersFor: (ticketID: string) => PrerequisiteView[];
  selectedTicketID: SourceAccessor<string | undefined>;
  interviewOwnsComposer: () => boolean;
  sendConversationMessage: (event: SubmitEvent) => Promise<void>;
  conversationPlaceholder: () => AssistantConversationPlaceholder;
}
