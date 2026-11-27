import { Show, untrack } from "solid-js";
import { ConversationSwitcher } from "../conversation-switcher";
import { Icon } from "../icon";
import { InboxSourceNavigation } from "../inbox/source-navigation";
import { ProjectSetupPanel } from "../setup/panel";
import { ChangeWriterStatus } from "../writer-status";
import { AssistantComposer } from "./assistant-composer";
import type { AssistantPanelModel } from "./assistant-panel-model";
import { AssistantStatusNotices } from "./assistant-status-notices";
import { AssistantThread } from "./assistant-thread";

export type { AssistantPanelModel } from "./assistant-panel-model";

export function AssistantPanel(props: { model: AssistantPanelModel }) {
  // The model identity is stable; its accessors retain live state.
  const model = untrack(() => props.model);
  const ticketImplementationSelected = () =>
    Boolean(
      model.assistantTicketID() && model.assistantTicketID() === model.selectedChange()?.ticketId,
    );
  return (
    <Show when={model.agentPresence.present()}>
      <section
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
        inert={!model.agentOpen()}
        ref={model.agentPanelElement}
      >
        <Show when={model.inboxSourceActive() && model.agentOverlay()}>
          <InboxSourceNavigation
            next={model.nextInboxItem()}
            busy={model.inboxSourceOpening() || model.inboxBusy()}
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
              title="Minimize Agent panel"
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
                ? (model.ticketList().find((ticket) => ticket.id === model.assistantTicketID())
                    ?.title ?? "Ticket chat")
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
          <AssistantStatusNotices model={model} />
          <AssistantThread model={model} />
          <Show when={model.canDevelopProject() && ticketImplementationSelected()}>
            <section aria-label="Ticket Workspace editing">
              <Show when={model.conversationMode() !== "build"}>
                <p class="agent-activity-notice">
                  Ticket Workspace editing. Shared across this Ticket's conversations.
                </p>
              </Show>
              <ChangeWriterStatus
                changeID={model.selectedChange()?.id}
                active={model.agentOpen()}
                onStatus={(changeID, view) => {
                  model.setCodingWriter({ changeID, view });
                }}
              />
            </section>
          </Show>
          <AssistantComposer
            model={model}
            ticketImplementationSelected={ticketImplementationSelected()}
          />
        </Show>
      </section>
    </Show>
  );
}
