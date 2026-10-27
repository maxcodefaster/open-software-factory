import type { Accessor, Setter, SourceAccessor } from "solid-js";
import type {
  AgentMessage,
  Change,
  ConversationView,
  RuntimeAttempt,
  RuntimeDockTarget,
} from "../api-contracts";
import type { ActivityNavigationRequest } from "../ide-messages";
import { serverCall } from "../server-functions/result";
import { ensureStaging } from "../server-functions/runtime";
import { ensureChangeSource, ensurePersonalSource } from "../server-functions/workspaces";
import type { WorkspaceTab } from "../workspace-tabs";
import type { DesktopMutation, TicketDetail } from "./contracts";

interface RuntimeNavigationDependencies {
  canDevelopProject: () => boolean;
  selectedProjectID: SourceAccessor<string | undefined>;
  changes: Accessor<Change[]>;
  loadTicketContext: (ticketID: string, read?: boolean) => void;
  setSelectedTicketID: Setter<string | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  resetAgentView: () => void;
  setConversation: (value: ConversationView | undefined) => void;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  mutate: DesktopMutation;
  updateWorkspaceTab: (tab: WorkspaceTab, key?: string | undefined) => void;
  refreshServerState: () => Promise<void>;
  selectedChange: Accessor<Change | undefined>;
  ideTargets: () => RuntimeDockTarget[];
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  setIDENavigation: Setter<ActivityNavigationRequest | undefined>;
  workspaceTabs: () => WorkspaceTab[];
  activateWorkspaceTab: (tab: WorkspaceTab) => void;
  attempts: Accessor<RuntimeAttempt[]>;
  previewTargets: () => RuntimeDockTarget[];
}

export function createRuntimeNavigation(dependencies: RuntimeNavigationDependencies) {
  async function openIDETarget(target: RuntimeDockTarget) {
    if (!dependencies.canDevelopProject()) return;
    const projectID = dependencies.selectedProjectID();
    if (!projectID) return;
    const tabID = `ide:${target.id}`;
    const change = target.changeId
      ? dependencies.changes().find((candidate) => candidate.id === target.changeId)
      : undefined;
    if (change) dependencies.loadTicketContext(change.ticketId);
    else {
      dependencies.setSelectedTicketID(undefined);
      dependencies.setDetail(undefined);
      dependencies.resetAgentView();
      dependencies.setConversation(undefined);
    }
    dependencies.openWorkspaceTab({
      id: tabID,
      view: "ide",
      label: `IDE · ${target.label}`,
      ...(target.attemptId ? { attemptID: target.attemptId } : {}),
      ...(target.changeId ? { changeID: target.changeId } : {}),
      ...(change ? { ticketID: change.ticketId } : {}),
    });
    await dependencies.mutate(async () => {
      const source = await serverCall(
        target.changeId
          ? ensureChangeSource({ data: [target.changeId] })
          : ensurePersonalSource({ data: [projectID] }),
      );
      dependencies.updateWorkspaceTab(
        {
          id: tabID,
          view: "ide",
          label: `IDE · ${target.label}`,
          workspaceID: source.workspaceID,
          ...(target.attemptId ? { attemptID: target.attemptId } : {}),
          ...(target.changeId ? { changeID: target.changeId } : {}),
          ...(change ? { ticketID: change.ticketId } : {}),
        },
        projectID,
      );
      await dependencies.refreshServerState();
    });
  }

  async function openChatActivity(message: AgentMessage, kind: "file" | "diff") {
    const navigation = message.activity?.navigation;
    const projectID = dependencies.selectedProjectID();
    const changeID = dependencies.selectedChange()?.id;
    const target = dependencies.ideTargets().find((candidate) => candidate.changeId === changeID);
    if (!navigation || !projectID || !changeID || !target || !dependencies.canDevelopProject())
      return;
    await openIDETarget(target);
    const tab = dependencies.activeWorkspaceTab();
    if (
      dependencies.selectedProjectID() !== projectID ||
      tab?.changeID !== changeID ||
      tab.view !== "ide" ||
      !tab.workspaceID
    )
      return;
    dependencies.setIDENavigation({
      id: crypto.randomUUID(),
      workspaceID: tab.workspaceID,
      path: navigation.path,
      kind,
      ...(navigation.diff ? { diff: navigation.diff } : {}),
      ...(navigation.truncated ? { truncated: true } : {}),
    });
  }

  async function openPreviewTarget(target: RuntimeDockTarget) {
    const existing = dependencies
      .workspaceTabs()
      .find(
        (tab) =>
          tab.view === "preview" &&
          (tab.id === `preview:${target.id}` ||
            Boolean(
              target.attemptId &&
                tab.attemptID === target.attemptId &&
                tab.appChannel === target.appChannel,
            )),
      );
    if (existing && (existing.attemptID || existing.appChannel)) {
      dependencies.activateWorkspaceTab(existing);
      return;
    }
    const projectID = dependencies.selectedProjectID();
    const tabID = `preview:${target.id}`;
    dependencies.openWorkspaceTab({
      id: tabID,
      view: "preview",
      label: `Preview · ${target.label}`,
      ...(target.attemptId ? { attemptID: target.attemptId } : {}),
      ...(target.appChannel ? { appChannel: target.appChannel } : {}),
    });
    if (target.attemptId) {
      return;
    }
    const stagingProjectID = target.projectId;
    if (!stagingProjectID) return;
    await dependencies.mutate(async () => {
      const attempt = await serverCall(ensureStaging({ data: [stagingProjectID] }));
      dependencies.updateWorkspaceTab(
        {
          id: tabID,
          view: "preview",
          label: `Preview · ${target.label}`,
          attemptID: attempt.id,
        },
        projectID,
      );
      await dependencies.refreshServerState();
    });
  }

  function ticketPreviewTarget(changeID: string | undefined) {
    if (!changeID) return undefined;
    const owned = new Set(
      dependencies
        .attempts()
        .filter(
          (attempt) =>
            attempt.projectId === dependencies.selectedProjectID() &&
            attempt.changeId === changeID &&
            attempt.state === "ready",
        )
        .map((attempt) => attempt.id),
    );
    return dependencies
      .previewTargets()
      .find((target) => target.attemptId && owned.has(target.attemptId) && target.appChannel);
  }

  function openDevelopmentPreview(attemptID: string, process: string, label: string) {
    const attempt = dependencies
      .attempts()
      .find(
        (candidate) =>
          candidate.id === attemptID &&
          candidate.projectId === dependencies.selectedProjectID() &&
          candidate.state === "ready" &&
          candidate.workspaceId !== null,
      );
    if (!attempt) return;
    dependencies.openWorkspaceTab({
      id: `preview:workspace:${attempt.workspaceId}:${process}`,
      view: "preview",
      label: `Development · ${label}`,
      attemptID,
      appChannel: process,
    });
  }

  return {
    openIDETarget,
    openChatActivity,
    openPreviewTarget,
    ticketPreviewTarget,
    openDevelopmentPreview,
  };
}
