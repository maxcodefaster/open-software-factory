import { Show } from "solid-js";
import { BuildModelControls } from "../agent/build-model-controls";
import { AgentBlockers } from "../agent/configuration";
import { buildAgentHint, buildAgentStatus } from "../agent-view-state";
import { composerKeyDown, resizeComposer } from "../assistant-interaction";
import { TextareaAttachments } from "../attachments/ui";
import { plainFailureMessage } from "../command-error";
import { Icon } from "../icon";
import { ChatSkillPicker } from "../skills/chat-picker";
import { CopyButton } from "../ui/feedback";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import type { AssistantPanelModel } from "./assistant-panel-model";

function HistoricalCodingNotice(props: { model: AssistantPanelModel }) {
  return (
    <div class="agent-activity-notice" role="status">
      <p>
        Previous conversation. Viewing it does not change the shared active Coding context. Your
        drafts stay with their conversation.
      </p>
      <Show
        when={
          props.model.conversation()?.codingHistory &&
          !props.model.conversation()?.codingHistory?.messagesAvailable
        }
      >
        <p>
          Live history is unavailable. Saved prompts and snapshots are retained. Viewing history
          does not start compute.
        </p>
      </Show>
      <Show when={props.model.retainedCodingDraft()}>
        {(draft) => (
          <details class="conversation-retained-draft">
            <summary>Unsent draft</summary>
            <p>{draft()}</p>
            <CopyButton
              class="quiet-button"
              value={draft()}
              scope={props.model.assistantKey()}
              accessibleLabel="Copy retained draft"
            />
          </details>
        )}
      </Show>
      <button
        type="button"
        class="quiet-button"
        onClick={() =>
          props.model.setConversationSelections((previous) => ({
            ...previous,
            [props.model.conversationScope()]:
              props.model.conversation()?.activeCodingContextId ?? "original",
          }))
        }
      >
        Return to active Coding
      </button>
    </div>
  );
}

function BuildComposerSection(props: { model: AssistantPanelModel }) {
  return (
    <>
      <Show
        when={
          !props.model.preparingImplementation() &&
          props.model.agent().lastError &&
          !props.model.agent().codingPause &&
          !(
            props.model.agent().stopPending &&
            props.model.agent().lastError?.startsWith("Stop remains unconfirmed.")
          )
        }
      >
        <p class="inline-error" role="alert">
          {props.model.agent().lastError}
        </p>
      </Show>
      <Show when={!props.model.preparingImplementation() && props.model.agent().codingPause}>
        <p class="agent-activity-notice" role="status">
          Coding is paused. Existing code is retained. Resume from the Ticket after its allowance is
          available.
        </p>
      </Show>
      <Show
        when={
          !props.model.preparingImplementation() &&
          props.model.agentViewLoaded() &&
          !props.model.agentCanRun()
        }
      >
        <p class="agent-unavailable">
          {props.model.selectedChange()?.state === "branch-pending"
            ? "Preparing the Change branch. Implementation will be available when it is ready."
            : `This Change is ${props.model.selectedChange()?.state ?? "unavailable"}. OpenCode is read-only.`}
        </p>
      </Show>
      <Show when={props.model.preparingImplementation()}>
        <Show when={props.model.preparingImplementation()?.failure}>
          <p class="inline-error" role="alert">
            {plainFailureMessage(props.model.preparingImplementation()?.failure ?? "")}
          </p>
        </Show>
        <p class="agent-activity-notice">
          Start approves this specification and begins implementation.
        </p>
      </Show>
      <Show
        when={
          props.model.preparingImplementation() ||
          (props.model.agentCanRun() && !props.model.agent().codingPause)
        }
      >
        <form
          class="agent-composer build-composer"
          onSubmit={(event) => {
            const prepared = props.model.preparingImplementation();
            if (prepared) {
              event.preventDefault();
              void props.model.implementTicket(prepared.revisionID, prepared.reasoning);
            } else if (!props.model.canPromptBuild()) {
              event.preventDefault();
              void props.model.startAgent();
            } else void props.model.promptAgent(event);
          }}
          onReset={(event) => {
            const input = event.currentTarget.querySelector("textarea");
            queueMicrotask(() => {
              if (input) resizeComposer(input);
            });
          }}
        >
          <Show when={props.model.canPromptBuild()}>
            <TextareaAttachments
              disabled={props.model.pending() || props.model.assistantContextLoading()}
              scopeKey={props.model.agentCommandScope(
                "change-prompt",
                props.model.selectedChange()?.id,
              )}
            >
              <textarea
                rows={1}
                onKeyDown={composerKeyDown}
                onInput={(event) => resizeComposer(event.currentTarget)}
                ref={(element) =>
                  props.model.restoreMessageDraft(element, () =>
                    props.model.agentCommandScope(
                      "change-prompt",
                      props.model.selectedChange()?.id,
                    ),
                  )
                }
                name="message"
                aria-label="Message conversation"
                placeholder={
                  props.model.codingWriterBlocked()
                    ? "Editing is held or being transferred. You can keep drafting…"
                    : props.model.agent().state === "failed"
                      ? "Describe what to fix in the retained code…"
                      : props.model.agent().state === "stopped"
                        ? "Ask a question or describe the next change…"
                        : props.model.agentTurnBusy()
                          ? "Prepare your next instructions, or Stop to change direction…"
                          : "Ask a question or describe the next change…"
                }
                disabled={props.model.pending() || props.model.assistantContextLoading()}
              />
            </TextareaAttachments>
          </Show>
          <div class="agent-compose-toolbar">
            <Show when={props.model.canPromptBuild()}>
              <ChatSkillPicker
                projectID={props.model.selectedProjectID()}
                workType="build"
                changeID={props.model.selectedChange()?.id}
                scope={props.model.agentCommandScope(
                  "change-prompt",
                  props.model.selectedChange()?.id,
                )}
                disabled={props.model.pending() || props.model.assistantContextLoading()}
              />
            </Show>
            <Show when={props.model.canDevelopProject()}>
              <Show
                when={props.model.preparingImplementation() || props.model.agentViewLoaded()}
                fallback={<span class="agent-model-controls">Loading implementation…</span>}
              >
                <BuildModelControls
                  projectID={props.model.selectedProjectID()}
                  changeID={props.model.selectedChange()?.id}
                  turn={
                    props.model.preparingImplementation() ? undefined : props.model.agent().turn
                  }
                  sessionAvailable={
                    !props.model.preparingImplementation() && props.model.agent().sessionAvailable
                  }
                  disabled={
                    props.model.pending() ||
                    (!props.model.preparingImplementation() &&
                      (props.model.agentTurnBusy() ||
                        props.model.agentNeedsResolution() ||
                        Boolean(props.model.agent().commitOperation) ||
                        props.model.agent().stopPending))
                  }
                  reasoning={
                    props.model.preparingImplementation()?.reasoning ??
                    props.model.chosenCodingReasoning()
                  }
                  onChange={(value) => {
                    if (props.model.preparingImplementation()) {
                      props.model.setImplementationPreparation((previous) =>
                        previous ? { ...previous, reasoning: value } : previous,
                      );
                      return;
                    }
                    const changeID = props.model.selectedChange()?.id;
                    if (changeID)
                      props.model.setCodingReasoningChoices((previous) => ({
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
                  !props.model.preparingImplementation() &&
                  (props.model.agentNeedsResolution() || props.model.agentTurnBusy())
                }
                fallback={
                  <button
                    type="submit"
                    class="agent-control primary"
                    aria-label={
                      props.model.preparingImplementation()
                        ? "Start implementation"
                        : !props.model.canPromptBuild()
                          ? props.model.agent().state === "failed"
                            ? "Retry implementation"
                            : "Start implementation"
                          : "Send message"
                    }
                    disabled={
                      props.model.pending() ||
                      props.model.assistantContextLoading() ||
                      props.model.codingWriterBlocked() ||
                      (!props.model.preparingImplementation() &&
                        (!props.model.agentViewLoaded() ||
                          props.model.agentNeedsResolution() ||
                          Boolean(props.model.agent().commitOperation) ||
                          props.model.agent().stopPending)) ||
                      (!props.model.canPromptBuild() && !props.model.modelRelayConfigured()) ||
                      props.model.blockersFor(props.model.selectedTicketID() ?? "").length > 0
                    }
                    title={
                      !props.model.modelRelayConfigured()
                        ? "Connect a Factory model before starting implementation"
                        : props.model.preparingImplementation()
                          ? "Start this specification with the selected reasoning"
                          : buildAgentHint(props.model.agent())
                    }
                  >
                    <Icon name={props.model.canPromptBuild() ? "send" : "play"} />
                    <Show
                      when={!props.model.canPromptBuild()}
                      fallback={
                        <span class="sr-only">
                          {props.model.agent().state === "stopped" ? "Resume" : "Send"}
                        </span>
                      }
                    >
                      {!props.model.preparingImplementation() &&
                      props.model.agent().state === "failed"
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
                    props.model.agentNeedsResolution() ? "Stop unresolved turn" : "Stop OpenCode"
                  }
                  disabled={props.model.pending() || props.model.agent().stopPending}
                  onClick={() => void props.model.stopAgent()}
                >
                  <Icon name="stop" />
                  <span class="sr-only">
                    {props.model.agentNeedsResolution() ? "Stop unresolved turn" : "Stop"}
                  </span>
                </button>
              </Show>
            </div>
          </div>
        </form>
        <Show when={!props.model.modelRelayConfigured()}>
          <p class="agent-configuration-note">
            Model connection required before implementation can start.
          </p>
        </Show>
      </Show>
    </>
  );
}

function ConversationComposerForm(props: { model: AssistantPanelModel }) {
  return (
    <form
      class="agent-composer conversation-composer"
      onSubmit={props.model.sendConversationMessage}
      onReset={(event) => {
        const input = event.currentTarget.querySelector("textarea");
        queueMicrotask(() => {
          if (input) resizeComposer(input);
        });
      }}
    >
      <TextareaAttachments
        disabled={
          props.model.assistantPending() ||
          props.model.assistantContextLoading() ||
          !props.model.selectedProject()
        }
        scopeKey={props.model.agentCommandScope("project-message")}
        privacy={props.model.assistantTicketID() ? "send" : "personal"}
      >
        <textarea
          rows={1}
          onKeyDown={composerKeyDown}
          onInput={(event) => resizeComposer(event.currentTarget)}
          ref={(element) =>
            props.model.restoreMessageDraft(element, () =>
              props.model.agentCommandScope("project-message"),
            )
          }
          name="message"
          aria-label="Message conversation"
          placeholder={props.model.conversationPlaceholder()}
          disabled={
            props.model.assistantPending() ||
            props.model.assistantContextLoading() ||
            !props.model.selectedProject()
          }
        />
      </TextareaAttachments>
      <div class="agent-compose-toolbar">
        <ChatSkillPicker
          projectID={props.model.selectedProjectID()}
          workType="planning"
          scope={props.model.agentCommandScope("project-message")}
          disabled={props.model.assistantPending()}
        />
        <button
          type="submit"
          class="agent-control primary"
          aria-label="Send message"
          disabled={
            props.model.assistantPending() ||
            props.model.assistantContextLoading() ||
            !props.model.selectedProject()
          }
        >
          <Icon name="send" />
          <span class="sr-only">Send</span>
        </button>
      </div>
    </form>
  );
}

export function AssistantComposer(props: {
  model: AssistantPanelModel;
  ticketImplementationSelected: boolean;
}) {
  const detachedImplementation = () => {
    const change = props.model.selectedChange();
    return change &&
      change.projectId === props.model.selectedProjectID() &&
      change.ticketId === props.model.selectedTicketID() &&
      !props.model.assistantTicketID() &&
      props.model.conversationMode() !== "build" &&
      props.model.canDevelopProject() &&
      props.model.agentViewLoaded() &&
      props.model.agentCanRun() &&
      (props.model.agentTurnBusy() ||
        props.model.agentNeedsResolution() ||
        props.model.agent().stopPending)
      ? change
      : undefined;
  };
  return (
    <div class={`agent-input-shell${props.model.pendingInterview() ? " interview-active" : ""}`}>
      <Show when={props.model.historicalCoding()}>
        <HistoricalCodingNotice model={props.model} />
      </Show>
      <Show when={!props.model.historicalCoding()}>
        <div class="assistant-context-row">
          <AgentBlockers
            projectID={props.model.selectedProjectID()}
            mode={props.model.conversationMode()}
            settingsOpen={props.model.workspaceView() === "settings"}
            onSettings={props.model.openSettings}
            turn={
              props.model.preparingImplementation()
                ? undefined
                : props.model.conversationMode() === "build" && props.model.selectedChange()
                  ? props.model.agent().turn
                  : props.model.conversation()?.turn
            }
          />
        </div>
        <Show when={detachedImplementation()}>
          {(change) => (
            <WorkspaceActionBar
              label="Retained Ticket implementation"
              status={
                <span>
                  {props.model.ticketList().find((ticket) => ticket.id === change().ticketId)
                    ?.title ?? "Selected Ticket"}{" "}
                  · {buildAgentStatus(props.model.agent())}
                </span>
              }
            >
              <button
                type="button"
                class="workspace-action"
                aria-label={
                  props.model.agentNeedsResolution() ? "Stop unresolved turn" : "Stop OpenCode"
                }
                disabled={props.model.pending() || props.model.agent().stopPending}
                onClick={() => void props.model.stopAgent()}
              >
                Stop implementation
              </button>
            </WorkspaceActionBar>
          )}
        </Show>
        <Show
          when={
            props.model.conversationMode() !== "build" &&
            props.ticketImplementationSelected &&
            props.model.conversation()
          }
        >
          <div class="agent-activity-notice" role="status" aria-label="Ticket implementation">
            <span>
              Implementation in another conversation ·{" "}
              {props.model.agentViewLoaded()
                ? buildAgentStatus(props.model.agent())
                : "Loading status…"}
            </span>
            <button
              type="button"
              class="quiet-button"
              onClick={() =>
                props.model.setConversationSelections((previous) => ({
                  ...previous,
                  [props.model.conversationScope()]:
                    props.model.conversation()?.activeCodingContextId ?? "original",
                }))
              }
            >
              Open active Coding
            </button>
          </div>
        </Show>
        <Show
          when={
            props.model.restoredMessageScope() ===
            props.model.agentCommandScope(
              props.model.conversationMode() === "build" ? "change-prompt" : "project-message",
              props.model.conversationMode() === "build"
                ? props.model.selectedChange()?.id
                : props.model.assistantTicketID(),
            )
          }
        >
          <p class="agent-activity-notice" role="status" aria-label="Message recovery">
            Previous send unconfirmed. Re-send unchanged text to check it.
          </p>
        </Show>
        <Show when={props.model.conversationMode() === "build"}>
          <BuildComposerSection model={props.model} />
        </Show>
        <Show
          when={props.model.conversationMode() !== "build" && !props.model.interviewOwnsComposer()}
        >
          <ConversationComposerForm model={props.model} />
        </Show>
      </Show>
    </div>
  );
}
