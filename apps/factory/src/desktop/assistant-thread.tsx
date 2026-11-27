import { For, Show } from "solid-js";
import { z } from "zod";
import { requirementContentInput } from "#requirement-domain/content";
import { buildAgentActivityStopped, buildAgentEmptyMessage } from "../agent-view-state";
import { followConversation } from "../assistant-interaction";
import {
  ChangeAgentActivityGroup,
  ChangeAgentMessage,
  ConversationEntryCard,
} from "../conversation-components";
import { markdownHTML } from "../editor/client";
import { Icon } from "../icon";
import { repositoryLink } from "../knowledge/source-link";
import type { ConversationView } from "../project-agent/contracts";
import type { AssistantPanelModel } from "./assistant-panel-model";

const ticketProposalSchema = z.object({
  title: z.string().max(200),
  description: z.string().max(10_000),
});

function reviewRequirements(
  model: AssistantPanelModel,
  entry: ConversationView["entries"][number],
) {
  const epic = model.epicProposals()[entry.id];
  if (epic) {
    const ticketID = model.assistantTicketID();
    model.openWorkspaceTab({
      id: `epic-proposal:${entry.id}`,
      view: "epic-proposal",
      label: epic.epic.title,
      proposalID: entry.id,
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
  const ticket = ticketProposalSchema.safeParse(entry.payload["ticket"]);
  const requirement = requirementContentInput.safeParse(entry.payload["requirement"]);
  if (!ticket.success || !requirement.success) return;
  const description = [
    ticket.data.description,
    requirement.data.summary,
    "## Acceptance criteria",
    ...requirement.data.acceptanceCriteria.map((value) => `- [ ] ${value}`),
    ...(requirement.data.nonGoals.length
      ? ["## Out of scope", ...requirement.data.nonGoals.map((value) => `- ${value}`)]
      : []),
  ].join("\n\n");
  if (description.length > 10_000) {
    model.setError("This proposal is too long for a Ticket draft. Ask for a more concise version.");
    return;
  }
  model.openTicketDraft({
    id: entry.id,
    title: ticket.data.title,
    description,
  });
}

function openCitation(
  model: AssistantPanelModel,
  citation: {
    source: "ticket" | "epic" | "knowledge" | "code" | "attachment";
    id: string;
    commitSha?: string | undefined;
    path?: string | undefined;
  },
) {
  const { source, id, commitSha, path } = citation;
  if (source === "ticket") {
    const ticket = model.ticketList().find((candidate) => candidate.id === id);
    if (ticket) model.selectTicket(id);
  } else if (source === "epic") {
    model.setSelectedEpicID(id);
  } else if (source === "attachment") {
    window.open(`/api/attachments/${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer");
  } else if (source === "code") {
    const repository = model.browserRepository();
    const link =
      repository && commitSha && path ? repositoryLink(repository, commitSha, path) : undefined;
    if (link) window.open(link, "_blank", "noopener,noreferrer");
  } else {
    model.selectKnowledgePage(id);
    void model.openKnowledge(false);
  }
}

function replyProgressLabel(model: AssistantPanelModel) {
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
}

export function AssistantThread(props: { model: AssistantPanelModel }) {
  return (
    <div
      class="agent-messages conversation-history"
      aria-live="polite"
      ref={(element) => {
        props.model.conversationScroll?.dispose();
        props.model.conversationScroll = followConversation(element);
      }}
    >
      <For each={props.model.visibleConversation()} keyed={(item) => item.id}>
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
                          stopped={buildAgentActivityStopped(props.model.agent())}
                          onNavigate={
                            props.model.canDevelopProject()
                              ? (message, kind) => void props.model.openChatActivity(message, kind)
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
                      stopped={buildAgentActivityStopped(props.model.agent())}
                      onNavigate={
                        props.model.canDevelopProject()
                          ? (message, kind) => void props.model.openChatActivity(message, kind)
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
                    props.model.answeredQuestionIDs().has(entry().id) ||
                    Boolean(props.model.answerSummary(entry().id))
                  }
                  answerSummary={props.model.answerSummary(entry().id)}
                  requirementCurrent={
                    props.model.latestRevision()?.id === entry().requirementRevisionId
                  }
                  requirementApproved={Boolean(
                    props.model
                      .detail()
                      ?.revisions.find((revision) => revision.id === entry().requirementRevisionId)
                      ?.approvalId,
                  )}
                  requirementVisible={
                    props.model.workspaceView() === "ticket" &&
                    Boolean(props.model.assistantTicketID())
                  }
                  pending={props.model.assistantPending()}
                  initialAnswer={props.model.restoredInterviewAnswer(entry().id)}
                  answerStorageKey={`interview-answer:${props.model.bootstrap.session.user.id}:${entry().id}`}
                  canAnswer={
                    props.model.pendingInterview() &&
                    props.model.currentInterviewQuestion()?.id === entry().id
                  }
                  onPause={() => props.model.pauseClarification(true)}
                  onResume={() => {
                    props.model.pauseClarification(false);
                    props.model.setAgentOpen(true);
                  }}
                  onAnswer={(event, question) =>
                    void props.model.answerInterview(event, entry().id, question)
                  }
                  onReviewRequirements={() => reviewRequirements(props.model, entry())}
                  onCitation={(citation) => openCitation(props.model, citation)}
                />
              )}
            </Show>
          );
        }}
      </For>
      <Show when={props.model.streamedAnswer()}>
        <article
          class="agent-message assistant"
          aria-label="Assistant streaming response"
          aria-busy="true"
        >
          <div
            class="markdown-body"
            innerHTML={markdownHTML(props.model.streamedAnswer()?.text ?? "")}
          />
        </article>
      </Show>
      <Show when={props.model.assistantPending() && !props.model.streamedAnswer()}>
        <section
          class="assistant-reply-placeholder"
          role="status"
          aria-label="Assistant responding"
          aria-busy="true"
        >
          <span>{replyProgressLabel(props.model)}</span>
          <div class="assistant-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </section>
      </Show>
      <Show
        when={
          props.model.visibleConversation().length === 0 &&
          !props.model.assistantPending() &&
          !["uncertain", "failed", "stopped"].includes(
            props.model.conversation()?.turn?.state ?? "",
          )
        }
      >
        <div class="agent-empty compact">
          <Icon name="agent" />
          <p>
            {props.model.assistantContextLoading()
              ? "Loading conversation…"
              : props.model.conversationMode() === "build"
                ? props.model.preparingImplementation()
                  ? "Choose reasoning for this Ticket's first Build."
                  : !props.model.agentViewLoaded()
                    ? "Loading implementation…"
                    : props.model.selectedChange()
                      ? buildAgentEmptyMessage(props.model.agent())
                      : "Approve the latest Requirement Revision to start Build."
                : props.model.assistantTicketID()
                  ? "Ask about this Ticket, or tell me what needs clarifying."
                  : "Ask about the Project, or describe a change you want to work on."}
          </p>
        </div>
      </Show>
    </div>
  );
}
