import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { For, Show, untrack } from "solid-js";
import { z } from "zod";
import type {
  ConversationMode,
  InterviewQuestion,
} from "../../../../packages/conversation-domain/src/conversation";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/content";
import type { PrerequisiteView } from "../../../../packages/ticket-domain/src/dependency";
import { BuildModelControls } from "../agent/build-model-controls";
import { AgentBlockers } from "../agent/configuration";
import {
  buildAgentActivityNotice,
  buildAgentEmptyMessage,
  buildAgentHint,
  buildAgentStatus,
} from "../agent-view-state";
import type {
  AgentMessage,
  AgentView,
  Change,
  ConversationView,
  Ticket,
  WriterView,
} from "../api-contracts";
import { composerKeyDown, followConversation, resizeComposer } from "../assistant-interaction";
import { TextareaAttachments } from "../attachments/ui";
import type { ConversationDisplayItem } from "../conversation-activity";
import {
  ChangeAgentActivityGroup,
  ChangeAgentMessage,
  ConversationEntryCard,
} from "../conversation-components";
import { ConversationSwitcher } from "../conversation-switcher";
import { Icon } from "../icon";
import type { InboxItem } from "../inbox/contracts";
import { InboxSourceNavigation } from "../inbox/source-navigation";
import { repositoryLink } from "../knowledge/source-link";
import type { createKnowledgeState } from "../knowledge/state";
import { markdownHTML } from "../markdown";
import type { createProjectPlanning } from "../projects/planning";
import { type createProjectSetupInteraction, ProjectSetupPanel } from "../setup/panel";
import { ChatSkillPicker } from "../skills/chat-picker";
import type { PersonalTicketDraft } from "../ticket-draft-workspace";
import { CopyButton } from "../ui/feedback";
import type { createWindowPresence } from "../window-presence";
import type { WorkspaceTab, WorkspaceView } from "../workspace-tabs";
import { ChangeWriterStatus } from "../writer-status";
import type { DesktopProject, FactoryDesktopProps, TicketDetail } from "./contracts";

export interface AssistantPanelModel {
  agentPresence: ReturnType<typeof createWindowPresence>;
  agentOpen: SourceAccessor<boolean>;
  agentOverlay: () => boolean;
  registrationOpen: SourceAccessor<boolean>;
  agentPanelElement: HTMLElement | undefined;
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
  setupVisible: () => boolean;
  preparingImplementation: () =>
    | {
        projectID: string;
        ticketID: string;
        revisionID: string;
        reasoning: CodingReasoning | undefined;
        failure: string | undefined;
      }
    | undefined;
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
  setImplementationPreparation: Setter<
    | {
        projectID: string;
        ticketID: string;
        revisionID: string;
        reasoning: CodingReasoning | undefined;
        failure: string | undefined;
      }
    | undefined
  >;
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
  workspaceView: () => WorkspaceView | undefined;
  restoredInterviewAnswer: (
    questionEntryID: string,
  ) => { selectedOptionIds: string[]; customText: string } | undefined;
  bootstrap: FactoryDesktopProps;
  pendingInterview: () => boolean;
  currentInterviewQuestion: SourceAccessor<
    | {
        id: string;
        ordinal: number;
        kind:
          | "requirement"
          | "user-message"
          | "agent-message"
          | "question"
          | "answer"
          | "mode-change";
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
    | undefined
  >;
  pauseClarification: (value: boolean) => void;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  answerInterview: (
    event: SubmitEvent,
    questionEntryID: string,
    question: InterviewQuestion,
  ) => Promise<void>;
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
  conversationPlaceholder: () =>
    | "Clarify this Ticket's requirements…"
    | "Describe the change you want to plan…"
    | "Ask about this Ticket…"
    | "Ask about this Project…";
}

export function AssistantPanel(props: { model: AssistantPanelModel }) {
  // The model identity is stable; its accessors retain live state.
  const model = untrack(() => props.model);
  return (
    <Show when={model.agentPresence.present()}>
      <aside
        class="agent-panel"
        data-closing={model.agentPresence.closing() ? "true" : "false"}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === "panel-out")
            model.agentPresence.finishExit();
        }}
        aria-hidden={model.agentOpen() ? "false" : "true"}
        {...(model.agentOverlay()
          ? { role: "dialog" as const, "aria-modal": "false" as const }
          : { role: "complementary" as const })}
        aria-label="Agent panel"
        inert={!model.agentOpen() || model.registrationOpen()}
        ref={model.agentPanelElement}
      >
        <Show when={model.inboxSourceActive() && model.agentOverlay()}>
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
        <Show when={model.setupVisible() || model.preparingImplementation()}>
          <header>
            <Show
              when={model.preparingImplementation()}
              fallback={<span class="sr-only">Assistant</span>}
            >
              <span class="agent-implementation-title" title={model.detail()?.ticket.title}>
                {model.detail()?.ticket.title}
              </span>
            </Show>
            <button
              type="button"
              class="bare-icon window-minimize-control"
              aria-label="Minimize Agent panel"
              onClick={model.dismissAgent}
            >
              <Icon name="minimize" />
            </button>
          </header>
        </Show>
        <Show when={model.setupVisible() && model.projectSetup}>
          {(setup) => (
            <ProjectSetupPanel
              setup={setup()}
              onSettings={model.openSettings}
              onProject={model.selectProject}
            />
          )}
        </Show>
        <Show when={!model.setupVisible()}>
          <ConversationSwitcher
            scopeKey={model.conversationScope()}
            title={
              model.assistantTicketID()
                ? (props.model
                    .ticketList()
                    .find((ticket) => ticket.id === model.assistantTicketID())?.title ??
                  "Ticket chat")
                : (model.selectedProject()?.name ?? "Project chat")
            }
            onMinimize={model.preparingImplementation() ? undefined : model.dismissAgent}
            conversation={model.conversation()}
            ticket={Boolean(model.assistantTicketID())}
            coding={Boolean(
              model.assistantTicketID() &&
                model.canDevelopProject() &&
                model.conversationMode() === "build",
            )}
            busy={model.assistantPending() || model.assistantContextLoading()}
            restartReason={
              model.codingWriterBlocked()
                ? "Editing is held or being transferred. Request editing or wait for release."
                : !model.agentViewLoaded()
                  ? "Loading the shared implementation status. Wait for confirmation."
                  : !model.agentCanRun()
                    ? "This implementation is not active. Create a follow-up Ticket or ask about the Project."
                    : undefined
            }
            canRestart={
              model.agentCanRun() &&
              !model.codingWriterBlocked() &&
              !model.agentTurnBusy() &&
              !model.agent().stopPending &&
              !model.agentNeedsResolution() &&
              ["committed", "stopped"].includes(model.agent().state)
            }
            onSelect={(id) =>
              model.setConversationSelections((previous) => ({
                ...previous,
                [model.conversationScope()]: id,
              }))
            }
            onResearch={() => void model.newConversation(false)}
            onCoding={() => void model.newConversation(true)}
          />
          <Show when={model.preparingImplementation()}>
            <div class="agent-status">
              <span class="agent-state">Ready to build</span>
              <button
                type="button"
                class="quiet-button"
                onClick={() => model.setImplementationPreparation(undefined)}
              >
                Back to conversation
              </button>
            </div>
          </Show>
          <Show when={model.conversationMode() === "build" && model.selectedChange()}>
            <div class="agent-status">
              <span class="agent-state">
                {!model.agentViewLoaded()
                  ? "Loading implementation…"
                  : model.agent().state === "idle" && !model.agentCanRun()
                    ? "Build unavailable"
                    : buildAgentStatus(model.agent())}
              </span>
              <span class={`runtime-presence ${model.ticketWorkspaceReady() ? "ready" : ""}`}>
                <i />
                {model.ticketWorkspaceStatus()}
              </span>
            </div>
          </Show>
          <Show
            when={
              model.conversationMode() === "build" &&
              model.selectedChange() &&
              model.agent().stopPending
            }
          >
            <section class="agent-stop-notice" aria-label="Stop recovery">
              <p class="agent-stop-copy" role="status">
                Stop saved. OpenCode confirmation is still missing. New Build work is blocked.
              </p>
              <details>
                <summary class="agent-stop-explanation">Why is Build blocked?</summary>
                <p class="agent-stop-detail">
                  {model.agent().lastError?.startsWith("Stop remains unconfirmed.")
                    ? model.agent().lastError
                    : "Factory cannot yet prove that execution and queued input are settled."}
                </p>
                <p class="agent-stop-detail">
                  Factory will not resend uncertain commands. Stop does not roll back workspace
                  edits.
                </p>
                <Show
                  when={model.agent().runtimeState !== "ready" || !model.agent().messagesAvailable}
                >
                  <p class="agent-stop-detail">
                    Live workspace status is unavailable. Queued input may survive a restart;
                    reconnecting alone does not confirm Stop.
                  </p>
                </Show>
                <p class="agent-stop-detail">
                  Checking status only reads the current outcome. It does not restart work.
                </p>
                <Show when={model.agent().stopId}>
                  <p class="agent-stop-detail">
                    Recheck confirmation checks OpenCode and saves confirmation only when it can
                    prove this Stop. It will not resend interruption, cancel input or start compute.
                  </p>
                  <button
                    type="button"
                    class="agent-control agent-stop-check"
                    disabled={model.pending()}
                    onClick={() => void model.recheckStopConfirmation()}
                  >
                    Recheck confirmation
                  </button>
                </Show>
              </details>
              <button
                type="button"
                class="agent-control agent-stop-check"
                disabled={model.pending()}
                onClick={() => void model.checkStopStatus()}
              >
                Check Stop status
              </button>
            </section>
          </Show>
          <Show
            when={
              model.conversationMode() === "build" &&
              model.selectedChange() &&
              model.agent().commitOperation &&
              !model.agent().stopPending
            }
          >
            <p class="agent-activity-notice" role="status" aria-label="Commit recovery">
              {buildAgentHint(model.agent())}
            </p>
          </Show>
          <Show
            when={
              model.conversationMode() === "build" &&
              model.selectedChange() &&
              buildAgentActivityNotice(model.agent())
            }
          >
            <p class="agent-activity-notice" role="status">
              {buildAgentActivityNotice(model.agent())}
            </p>
          </Show>
          <Show
            when={
              model.conversationMode() === "build" &&
              model.selectedChange() &&
              model.agent().state === "working" &&
              !model.agent().runtimeConnected &&
              !model.agent().stopPending &&
              !model.agent().commitOperation
            }
          >
            <p class="agent-activity-notice" role="status" aria-label="Build connection">
              {buildAgentHint(model.agent())}
            </p>
          </Show>
          <div
            class="agent-messages conversation-history"
            aria-live="polite"
            ref={(element) => {
              model.conversationScroll?.dispose();
              model.conversationScroll = followConversation(element);
            }}
          >
            <For each={model.visibleConversation()} keyed={(item) => item.id}>
              {(item) => {
                const conversationEntry = () => {
                  const current = item();
                  return current.kind === "conversation" ? current.entry : undefined;
                };
                const agentMessage = () => {
                  const current = item();
                  return current.kind === "change-agent" ? current.message : undefined;
                };
                const activityMessages = () => {
                  const current = item();
                  return current.kind === "activity-group" ? current.messages : undefined;
                };
                return (
                  <Show
                    when={conversationEntry()}
                    fallback={
                      <Show
                        when={activityMessages()}
                        fallback={
                          <Show when={agentMessage()}>
                            {(message) => (
                              <ChangeAgentMessage
                                message={message()}
                                onNavigate={
                                  model.canDevelopProject()
                                    ? (message, kind) => void model.openChatActivity(message, kind)
                                    : undefined
                                }
                              />
                            )}
                          </Show>
                        }
                      >
                        {(messages) => (
                          <ChangeAgentActivityGroup
                            messages={messages()}
                            onNavigate={
                              model.canDevelopProject()
                                ? (message, kind) => void model.openChatActivity(message, kind)
                                : undefined
                            }
                          />
                        )}
                      </Show>
                    }
                  >
                    {(entry) => (
                      <ConversationEntryCard
                        entry={entry()}
                        answered={
                          model.answeredQuestionIDs().has(entry().id) ||
                          Boolean(model.answerSummary(entry().id))
                        }
                        answerSummary={model.answerSummary(entry().id)}
                        requirementCurrent={
                          model.latestRevision()?.id === entry().requirementRevisionId
                        }
                        requirementApproved={Boolean(
                          props.model
                            .detail()
                            ?.revisions.find(
                              (revision) => revision.id === entry().requirementRevisionId,
                            )?.approvalId,
                        )}
                        requirementVisible={
                          model.workspaceView() === "ticket" && Boolean(model.assistantTicketID())
                        }
                        pending={model.assistantPending()}
                        initialAnswer={model.restoredInterviewAnswer(entry().id)}
                        answerStorageKey={`interview-answer:${model.bootstrap.session.user.id}:${entry().id}`}
                        canAnswer={
                          model.pendingInterview() &&
                          model.currentInterviewQuestion()?.id === entry().id
                        }
                        onPause={() => model.pauseClarification(true)}
                        onResume={() => {
                          model.pauseClarification(false);
                          model.setAgentOpen(true);
                        }}
                        onAnswer={(event, question) =>
                          void model.answerInterview(event, entry().id, question)
                        }
                        onReviewRequirements={() => {
                          const epic = model.epicProposals()[entry().id];
                          if (epic) {
                            const ticketID = model.assistantTicketID();
                            model.openWorkspaceTab({
                              id: `epic-proposal:${entry().id}`,
                              view: "epic-proposal",
                              label: epic.epic.title,
                              proposalID: entry().id,
                              ...(ticketID ? { ticketID } : {}),
                            });
                            model.setAgentOpen(false);
                            return;
                          }
                          const ticketID = model.assistantTicketID();
                          if (ticketID) {
                            model.selectTicket(ticketID);
                            return;
                          }
                          const ticket = z
                            .object({
                              title: z.string().max(200),
                              description: z.string().max(10_000),
                            })
                            .safeParse(entry().payload["ticket"]);
                          const requirement = requirementContentInput.safeParse(
                            entry().payload["requirement"],
                          );
                          if (!ticket.success || !requirement.success) return;
                          const description = [
                            ticket.data.description,
                            requirement.data.summary,
                            "## Acceptance criteria",
                            ...requirement.data.acceptanceCriteria.map((value) => `- [ ] ${value}`),
                            ...(requirement.data.nonGoals.length
                              ? [
                                  "## Out of scope",
                                  ...requirement.data.nonGoals.map((value) => `- ${value}`),
                                ]
                              : []),
                          ].join("\n\n");
                          if (description.length > 10_000) {
                            model.setError(
                              "This proposal is too long for a Ticket draft. Ask for a more concise version.",
                            );
                            return;
                          }
                          model.openTicketDraft({
                            id: entry().id,
                            title: ticket.data.title,
                            description,
                          });
                        }}
                        onCitation={({ source, id, commitSha, path }) => {
                          if (source === "ticket") {
                            const ticket = props.model
                              .ticketList()
                              .find((candidate) => candidate.id === id);
                            if (ticket) model.selectTicket(id);
                          } else if (source === "epic") {
                            model.setSelectedEpicID(id);
                          } else if (source === "attachment") {
                            window.open(
                              `/api/attachments/${encodeURIComponent(id)}`,
                              "_blank",
                              "noopener,noreferrer",
                            );
                          } else if (source === "code") {
                            const repository = model.browserRepository();
                            const link =
                              repository && commitSha && path
                                ? repositoryLink(repository, commitSha, path)
                                : undefined;
                            if (link) window.open(link, "_blank", "noopener,noreferrer");
                          } else {
                            model.selectKnowledgePage(id);
                            void model.openKnowledge(false);
                          }
                        }}
                      />
                    )}
                  </Show>
                );
              }}
            </For>
            <Show when={model.streamedAnswer()}>
              <article
                class="agent-message assistant"
                aria-label="Assistant streaming response"
                aria-busy="true"
              >
                <div
                  class="markdown-body"
                  innerHTML={markdownHTML(model.streamedAnswer()?.text ?? "")}
                />
              </article>
            </Show>
            <Show when={model.assistantPending() && !model.streamedAnswer()}>
              <section
                class="assistant-reply-placeholder"
                role="status"
                aria-label="Assistant responding"
                aria-busy="true"
              >
                <span>
                  {(() => {
                    const progress = model.conversation()?.turn?.progress;
                    if (!progress) return "Preparing a response…";
                    const label = {
                      guidance: "Loading Project guidance…",
                      thinking: "Preparing a response…",
                      searching: "Searching the Project…",
                      reading: "Reading Project sources…",
                      validating: "Checking the response…",
                    }[progress.phase];
                    return `${label}${progress.completedLookups ? ` · ${progress.completedLookups} research steps completed` : ""}`;
                  })()}
                </span>
                <div class="assistant-skeleton" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </section>
            </Show>
            <Show
              when={
                model.visibleConversation().length === 0 &&
                !model.assistantPending() &&
                !["uncertain", "failed", "stopped"].includes(
                  model.conversation()?.turn?.state ?? "",
                )
              }
            >
              <div class="agent-empty compact">
                <Icon name="agent" />
                <p>
                  {model.conversationMode() === "build"
                    ? model.preparingImplementation()
                      ? "Choose reasoning for this Ticket's first Build."
                      : !model.agentViewLoaded()
                        ? "Loading implementation…"
                        : model.selectedChange()
                          ? buildAgentEmptyMessage(model.agent())
                          : "Approve the latest Requirement Revision to start Build."
                    : model.assistantTicketID()
                      ? "Ask about this Ticket, or tell me what needs clarifying."
                      : "Ask about the Project, or describe a change you want to work on."}
                </p>
              </div>
            </Show>
          </div>
          <Show when={model.canDevelopProject()}>
            <ChangeWriterStatus
              changeID={model.assistantTicketID() ? model.selectedChange()?.id : undefined}
              active={model.agentOpen()}
              onStatus={(changeID, view) => {
                model.setCodingWriter({ changeID, view });
              }}
            />
          </Show>
          <div class={`agent-input-shell${model.pendingInterview() ? " interview-active" : ""}`}>
            <Show when={model.historicalCoding()}>
              <div class="agent-activity-notice" role="status">
                <p>
                  Previous conversation. Viewing it does not change the shared active Coding
                  context. Your drafts stay with their conversation.
                </p>
                <Show
                  when={
                    model.conversation()?.codingHistory &&
                    !model.conversation()?.codingHistory?.messagesAvailable
                  }
                >
                  <p>
                    Live history is unavailable. Saved prompts and snapshots are retained. Viewing
                    history does not start compute.
                  </p>
                </Show>
                <Show when={model.retainedCodingDraft()}>
                  {(draft) => (
                    <details class="conversation-retained-draft">
                      <summary>Unsent draft</summary>
                      <p>{draft()}</p>
                      <CopyButton
                        class="quiet-button"
                        value={draft()}
                        scope={model.assistantKey()}
                        accessibleLabel="Copy retained draft"
                      />
                    </details>
                  )}
                </Show>
                <button
                  type="button"
                  class="quiet-button"
                  onClick={() =>
                    model.setConversationSelections((previous) => ({
                      ...previous,
                      [model.conversationScope()]:
                        model.conversation()?.activeCodingContextId ?? "original",
                    }))
                  }
                >
                  Return to active Coding
                </button>
              </div>
            </Show>
            <Show when={!model.historicalCoding()}>
              <div class="assistant-context-row">
                <AgentBlockers
                  projectID={model.selectedProjectID()}
                  mode={model.conversationMode()}
                  settingsOpen={model.workspaceView() === "settings"}
                  onSettings={model.openSettings}
                  turn={
                    model.preparingImplementation()
                      ? undefined
                      : model.conversationMode() === "build" && model.selectedChange()
                        ? model.agent().turn
                        : model.conversation()?.turn
                  }
                />
              </div>
              <Show when={model.conversationMode() !== "build" && model.agentTurnBusy()}>
                <div class="agent-activity-notice" role="status">
                  <span>Implementation continues in its Workspace.</span>
                  <button
                    type="button"
                    class="agent-control"
                    aria-label="Stop OpenCode"
                    onClick={() => void model.stopAgent()}
                  >
                    <Icon name="stop" /> Stop
                  </button>
                </div>
              </Show>
              <Show
                when={
                  model.restoredMessageScope() ===
                  model.agentCommandScope(
                    model.conversationMode() === "build" ? "change-prompt" : "project-message",
                    model.conversationMode() === "build"
                      ? model.selectedChange()?.id
                      : model.assistantTicketID(),
                  )
                }
              >
                <p class="agent-activity-notice" role="status" aria-label="Message recovery">
                  Previous send unconfirmed. Re-send unchanged text to check it.
                </p>
              </Show>
              <Show when={model.conversationMode() === "build"}>
                <Show
                  when={
                    !model.preparingImplementation() &&
                    model.agent().lastError &&
                    !model.agent().codingPause &&
                    !(
                      model.agent().stopPending &&
                      model.agent().lastError?.startsWith("Stop remains unconfirmed.")
                    )
                  }
                >
                  <p class="inline-error" role="alert">
                    {model.agent().lastError}
                  </p>
                </Show>
                <Show when={!model.preparingImplementation() && model.agent().codingPause}>
                  <p class="agent-activity-notice" role="status">
                    Coding is paused. Existing code is retained. Resume from the Ticket after its
                    allowance is available.
                  </p>
                </Show>
                <Show
                  when={
                    !model.preparingImplementation() &&
                    model.agentViewLoaded() &&
                    !model.agentCanRun()
                  }
                >
                  <p class="agent-unavailable">
                    {model.selectedChange()?.state === "branch-pending"
                      ? "Preparing the Change branch. Implementation will be available when it is ready."
                      : `This Change is ${model.selectedChange()?.state ?? "unavailable"}. OpenCode is read-only.`}
                  </p>
                </Show>
                <Show when={model.preparingImplementation()}>
                  <Show when={model.preparingImplementation()?.failure}>
                    <p class="inline-error" role="alert">
                      {model.preparingImplementation()?.failure}
                    </p>
                  </Show>
                  <p class="agent-activity-notice">
                    Start approves this specification and begins implementation.
                  </p>
                </Show>
                <Show
                  when={
                    model.preparingImplementation() ||
                    (model.agentCanRun() && !model.agent().codingPause)
                  }
                >
                  <form
                    class="agent-composer build-composer"
                    onSubmit={(event) => {
                      const prepared = model.preparingImplementation();
                      if (prepared) {
                        event.preventDefault();
                        void model.implementTicket(prepared.revisionID, prepared.reasoning);
                      } else if (!model.canPromptBuild()) {
                        event.preventDefault();
                        void model.startAgent();
                      } else void model.promptAgent(event);
                    }}
                    onReset={(event) => {
                      const input = event.currentTarget.querySelector("textarea");
                      queueMicrotask(() => {
                        if (input) resizeComposer(input);
                      });
                    }}
                  >
                    <Show when={model.canPromptBuild()}>
                      <TextareaAttachments
                        disabled={model.pending() || model.assistantContextLoading()}
                        scopeKey={model.agentCommandScope(
                          "change-prompt",
                          model.selectedChange()?.id,
                        )}
                      >
                        <textarea
                          rows={1}
                          onKeyDown={composerKeyDown}
                          onInput={(event) => resizeComposer(event.currentTarget)}
                          ref={(element) =>
                            model.restoreMessageDraft(element, () =>
                              model.agentCommandScope("change-prompt", model.selectedChange()?.id),
                            )
                          }
                          name="message"
                          aria-label="Message conversation"
                          placeholder={
                            model.codingWriterBlocked()
                              ? "Editing is held or being transferred. You can keep drafting…"
                              : model.agent().state === "failed"
                                ? "Describe what to fix in the retained code…"
                                : model.agent().state === "stopped"
                                  ? "Ask a question or describe the next change…"
                                  : model.agentTurnBusy()
                                    ? "Prepare your next instructions, or Stop to change direction…"
                                    : "Ask a question or describe the next change…"
                          }
                          disabled={model.pending() || model.assistantContextLoading()}
                        />
                      </TextareaAttachments>
                    </Show>
                    <div class="agent-compose-toolbar">
                      <Show when={model.canPromptBuild()}>
                        <ChatSkillPicker
                          projectID={model.selectedProjectID()}
                          workType="build"
                          changeID={model.selectedChange()?.id}
                          scope={model.agentCommandScope(
                            "change-prompt",
                            model.selectedChange()?.id,
                          )}
                          disabled={model.pending() || model.assistantContextLoading()}
                        />
                      </Show>
                      <Show when={model.canDevelopProject()}>
                        <Show
                          when={model.preparingImplementation() || model.agentViewLoaded()}
                          fallback={
                            <span class="agent-model-controls">Loading implementation…</span>
                          }
                        >
                          <BuildModelControls
                            projectID={model.selectedProjectID()}
                            changeID={model.selectedChange()?.id}
                            turn={model.preparingImplementation() ? undefined : model.agent().turn}
                            sessionAvailable={
                              !model.preparingImplementation() && model.agent().sessionAvailable
                            }
                            disabled={
                              model.pending() ||
                              (!model.preparingImplementation() &&
                                (model.agentTurnBusy() ||
                                  model.agentNeedsResolution() ||
                                  Boolean(model.agent().commitOperation) ||
                                  model.agent().stopPending))
                            }
                            reasoning={
                              model.preparingImplementation()?.reasoning ??
                              model.chosenCodingReasoning()
                            }
                            onChange={(value) => {
                              if (model.preparingImplementation()) {
                                model.setImplementationPreparation((previous) =>
                                  previous ? { ...previous, reasoning: value } : previous,
                                );
                                return;
                              }
                              const changeID = model.selectedChange()?.id;
                              if (changeID)
                                model.setCodingReasoningChoices((previous) => ({
                                  ...previous,
                                  [changeID]: value,
                                }));
                            }}
                          />
                        </Show>
                      </Show>
                      <div class="composer-actions">
                        <Show
                          when={
                            !model.preparingImplementation() &&
                            (model.agentNeedsResolution() || model.agentTurnBusy())
                          }
                          fallback={
                            <button
                              type="submit"
                              class="agent-control primary"
                              aria-label={
                                model.preparingImplementation()
                                  ? "Start implementation"
                                  : !model.canPromptBuild()
                                    ? model.agent().state === "failed"
                                      ? "Retry implementation"
                                      : "Start implementation"
                                    : "Send message"
                              }
                              disabled={
                                model.pending() ||
                                model.assistantContextLoading() ||
                                model.codingWriterBlocked() ||
                                (!model.preparingImplementation() &&
                                  (!model.agentViewLoaded() ||
                                    model.agentNeedsResolution() ||
                                    Boolean(model.agent().commitOperation) ||
                                    model.agent().stopPending)) ||
                                (!model.canPromptBuild() && !model.modelRelayConfigured()) ||
                                model.blockersFor(model.selectedTicketID() ?? "").length > 0
                              }
                              title={
                                !model.modelRelayConfigured()
                                  ? "Connect a Factory model before starting implementation"
                                  : model.preparingImplementation()
                                    ? "Start this specification with the selected reasoning"
                                    : buildAgentHint(model.agent())
                              }
                            >
                              <Icon name={model.canPromptBuild() ? "send" : "play"} />
                              <Show
                                when={!model.canPromptBuild()}
                                fallback={
                                  <span class="sr-only">
                                    {model.agent().state === "stopped" ? "Resume" : "Send"}
                                  </span>
                                }
                              >
                                {!model.preparingImplementation() &&
                                model.agent().state === "failed"
                                  ? "Retry"
                                  : "Start"}
                              </Show>
                            </button>
                          }
                        >
                          <button
                            type="button"
                            class="agent-control"
                            aria-label={
                              model.agentNeedsResolution()
                                ? "Stop unresolved turn"
                                : "Stop OpenCode"
                            }
                            disabled={model.pending() || model.agent().stopPending}
                            onClick={() => void model.stopAgent()}
                          >
                            <Icon name="stop" />
                            <span class="sr-only">
                              {model.agentNeedsResolution() ? "Stop unresolved turn" : "Stop"}
                            </span>
                          </button>
                        </Show>
                      </div>
                    </div>
                  </form>
                  <Show when={!model.modelRelayConfigured()}>
                    <p class="agent-configuration-note">
                      Model connection required before implementation can start.
                    </p>
                  </Show>
                </Show>
              </Show>
              <Show when={model.conversationMode() !== "build" && !model.interviewOwnsComposer()}>
                <form
                  class="agent-composer conversation-composer"
                  onSubmit={model.sendConversationMessage}
                  onReset={(event) => {
                    const input = event.currentTarget.querySelector("textarea");
                    queueMicrotask(() => {
                      if (input) resizeComposer(input);
                    });
                  }}
                >
                  <TextareaAttachments
                    disabled={
                      model.assistantPending() ||
                      model.assistantContextLoading() ||
                      !model.selectedProject()
                    }
                    scopeKey={model.agentCommandScope("project-message")}
                    privacy={model.assistantTicketID() ? "send" : "personal"}
                  >
                    <textarea
                      rows={1}
                      onKeyDown={composerKeyDown}
                      onInput={(event) => resizeComposer(event.currentTarget)}
                      ref={(element) =>
                        model.restoreMessageDraft(element, () =>
                          model.agentCommandScope("project-message"),
                        )
                      }
                      name="message"
                      aria-label="Message conversation"
                      placeholder={model.conversationPlaceholder()}
                      disabled={
                        model.assistantPending() ||
                        model.assistantContextLoading() ||
                        !model.selectedProject()
                      }
                    />
                  </TextareaAttachments>
                  <div class="agent-compose-toolbar">
                    <ChatSkillPicker
                      projectID={model.selectedProjectID()}
                      workType="planning"
                      scope={model.agentCommandScope("project-message")}
                      disabled={model.assistantPending()}
                    />
                    <button
                      type="submit"
                      class="agent-control primary"
                      aria-label="Send message"
                      disabled={
                        model.assistantPending() ||
                        model.assistantContextLoading() ||
                        !model.selectedProject()
                      }
                    >
                      <Icon name="send" />
                      <span class="sr-only">Send</span>
                    </button>
                  </div>
                </form>
              </Show>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
  );
}
