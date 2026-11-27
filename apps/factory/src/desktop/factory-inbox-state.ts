import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { createSignal, onCleanup, onSettled } from "solid-js";
import { plainErrorMessage } from "../command-error";
import { createInboxClient, revealInboxSource } from "../inbox/client";
import type { InboxItem } from "../inbox/contracts";
import { type InboxQueue, initialInboxPosition, nextInboxQueueItem } from "../inbox/navigation";
import type { WorkspaceTab } from "../workspace-tabs";

export interface FactoryInboxStateDependencies {
  selectedProjectID: SourceAccessor<string | undefined>;
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  narrowViewport: Accessor<boolean>;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  setConversationSelections: Setter<Record<string, string>>;
  pauseClarification: (value: boolean) => void;
  setWorkspaceFocusTarget: Setter<string | undefined>;
  setError: Setter<string>;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  selectProject: (projectID: string, fromInbox?: boolean, publish?: boolean) => void;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  refreshConversation: (projectID?: string, ticketID?: string) => Promise<unknown>;
  refreshTicketDetail: (ticketID?: string) => Promise<unknown>;
}

export function createFactoryInboxState(dependencies: FactoryInboxStateDependencies) {
  const inbox = createInboxClient();
  const [inboxPosition, setInboxPosition] = createSignal(initialInboxPosition());
  const [inboxRestoreKey, setInboxRestoreKey] = createSignal(0);
  const [inboxQueue, setInboxQueue] = createSignal<InboxQueue>();
  const [inboxSourceOpening, setInboxSourceOpening] = createSignal(false);
  const [inboxFeedbackID, setInboxFeedbackID] = createSignal<string>();
  let inboxNavigation: AbortController | undefined;
  onCleanup(() => inboxNavigation?.abort());

  function clearNavigation(resetQueue = true) {
    inboxNavigation?.abort();
    if (resetQueue) {
      setInboxQueue(undefined);
      setInboxSourceOpening(false);
    }
  }

  function returnToInbox(publish = true) {
    clearNavigation(true);
    setInboxRestoreKey((key) => key + 1);
    if (dependencies.narrowViewport()) dependencies.setAgentOpen(false);
    dependencies.openWorkspaceTab({ id: "inbox", view: "inbox", label: "Inbox" }, publish);
  }

  const inboxSourceActive = () => {
    const item = inboxQueue()?.current;
    if (!item || item.projectId !== dependencies.selectedProjectID()) return false;
    const tabID =
      item.target === "inputs"
        ? `inbox-inputs:${item.projectId}:${item.targetId}`
        : item.ticketId
          ? `ticket:${item.ticketId}`
          : "inbox";
    return dependencies.activeWorkspaceTab()?.id === tabID;
  };

  const nextInboxItem = () => {
    const queue = inboxQueue();
    return queue ? nextInboxQueueItem(queue, inbox.view()?.items ?? []) : undefined;
  };

  async function openInboxItem(item: InboxItem) {
    inboxNavigation?.abort();
    if (dependencies.narrowViewport() && item.target !== "conversation" && item.target !== "coding")
      dependencies.setAgentOpen(false);
    if (dependencies.selectedProjectID() !== item.projectId) {
      dependencies.selectProject(item.projectId, true, false);
      const switching = new AbortController();
      inboxNavigation = switching;
      // Solid 2 event handlers read the pre-write snapshot until the switch settles.
      // Otherwise the Ticket tab can be added to the previous Project's workspace.
      await new Promise<void>((resolve) => onSettled(resolve));
      if (switching.signal.aborted || dependencies.selectedProjectID() !== item.projectId) return;
    }
    if (item.target === "inputs")
      dependencies.openWorkspaceTab({
        id: `inbox-inputs:${item.projectId}:${item.targetId}`,
        view: "settings",
        label: "Inputs",
        settingsProject: { id: item.projectId, name: item.projectName },
        settingsSelection: { scope: "project", category: "monitoring" },
      });
    else if (item.ticketId) dependencies.selectTicket(item.ticketId, true);
    else dependencies.openWorkspaceTab({ id: "inbox", view: "inbox", label: "Inbox" });
    const navigation = new AbortController();
    inboxNavigation = navigation;
    try {
      const conversationTarget = item.target === "conversation" || item.target === "coding";
      if (conversationTarget) {
        dependencies.setConversationSelections((previous) => ({
          ...previous,
          [`${item.projectId}:${item.ticketId ?? "none"}`]: item.contextId ?? "original",
        }));
        dependencies.setAgentOpen(true);
      }
      await new Promise<void>((resolve) => onSettled(resolve));
      if (navigation.signal.aborted || dependencies.selectedProjectID() !== item.projectId) return;
      if (conversationTarget) {
        dependencies.pauseClarification(false);
        await dependencies.refreshConversation(item.projectId, item.ticketId ?? undefined);
      } else if (item.target === "review") {
        setInboxFeedbackID(item.targetId ?? undefined);
      }
      if (item.ticketId && item.target !== "inputs")
        await dependencies.refreshTicketDetail(item.ticketId);
      if (navigation.signal.aborted) return;
      // Inbox navigation owns focus, including sources in the Assistant.
      // A late document mount must not steal it back into the workspace.
      dependencies.setWorkspaceFocusTarget(undefined);
      await new Promise<void>((resolve) => onSettled(resolve));
      if (navigation.signal.aborted) return;
      const selector =
        item.target === "inputs"
          ? `#input-event-${item.targetId}`
          : item.target === "coding" && item.targetId
            ? `#coding-message-${CSS.escape(item.targetId)}`
            : item.target === "conversation"
              ? item.targetId
                ? `#conversation-entry-${item.targetId}`
                : ".agent-panel"
              : item.target === "review" && item.targetId
                ? `#review-feedback-${item.targetId}`
                : ".ticket-document:not([hidden])";
      await revealInboxSource(selector, navigation.signal);
      if (item.unread) await inbox.mark(item, "read");
    } catch (cause) {
      if (!navigation.signal.aborted)
        dependencies.setError(
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "The Inbox source could not be opened.",
        );
    }
  }

  async function startInboxItem(item: InboxItem, ids?: readonly string[]) {
    if (inboxSourceOpening()) return;
    const previous = inboxQueue();
    const queue: InboxQueue = {
      ids: ids ?? previous?.ids ?? [item.id],
      current: item,
      section: ids ? inboxPosition().section : (previous?.section ?? inboxPosition().section),
      project: ids ? inboxPosition().project : (previous?.project ?? inboxPosition().project),
    };
    setInboxQueue(queue);
    setInboxSourceOpening(true);
    setInboxPosition((position) => ({
      ...position,
      selectedId: item.id,
      index: queue.ids.indexOf(item.id),
    }));
    try {
      await openInboxItem(item);
    } finally {
      if (inboxQueue() === queue) setInboxSourceOpening(false);
    }
  }

  return {
    inbox,
    inboxPosition,
    setInboxPosition,
    inboxRestoreKey,
    inboxSourceOpening,
    inboxFeedbackID,
    setInboxFeedbackID,
    clearNavigation,
    returnToInbox,
    inboxSourceActive,
    nextInboxItem,
    startInboxItem,
  };
}
