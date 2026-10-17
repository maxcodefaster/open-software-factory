export type WorkspaceView =
  | "ticket-draft"
  | "ticket"
  | "epic-proposal"
  | "knowledge"
  | "ide"
  | "preview"
  | "inbox"
  | "settings"
  | "trash";

export type WorkspaceTab = {
  id: string;
  view: WorkspaceView;
  label: string;
  ticketID?: string;
  attemptID?: string;
  workspaceID?: string;
  appChannel?: string;
  changeID?: string;
  settingsProject?: { id: string; name: string };
  settingsSelection?: { scope: "personal" | "project" | "system"; category: "people" | "security" };
  proposalID?: string;
};

export type ProjectWorkspaceState = {
  tabs: WorkspaceTab[];
  activeTabID?: string;
};

export function workspaceTabRuntimeURL(tab: WorkspaceTab, embedded = false) {
  if (tab.view === "ide")
    return tab.workspaceID
      ? `/api/developer-ide/access?${embedded ? "embed=1&" : ""}workspace=${encodeURIComponent(tab.workspaceID)}`
      : undefined;
  if (!tab.attemptID || tab.view !== "preview") return undefined;
  const path = tab.appChannel
    ? `/runtime/${tab.attemptID}/preview/${tab.appChannel}/`
    : `/runtime/${tab.attemptID}/app/`;
  return `/api/runtime-access?${embedded ? "embed=1&" : ""}path=${encodeURIComponent(path)}`;
}

export function selectedWorkspaceTab(state: ProjectWorkspaceState | undefined) {
  return state?.tabs.find((tab) => tab.id === state.activeTabID) ?? state?.tabs[0];
}

export function openWorkspaceTabState(
  state: ProjectWorkspaceState,
  tab: WorkspaceTab,
): ProjectWorkspaceState {
  const tabs = state.tabs.some((candidate) => candidate.id === tab.id)
    ? state.tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate))
    : [...state.tabs, tab];
  return { tabs, activeTabID: tab.id };
}

export function updateWorkspaceTabState(
  state: ProjectWorkspaceState,
  tab: WorkspaceTab,
): ProjectWorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate)),
  };
}

export function followStagingPromotion(
  state: ProjectWorkspaceState,
  projectID: string,
  readyAttemptID: string | undefined,
): ProjectWorkspaceState {
  if (!readyAttemptID) return state;
  const stagingID = `preview:staging:${projectID}`;
  const tab = state.tabs.find((candidate) => candidate.id === stagingID);
  if (tab?.view !== "preview" || tab.appChannel || tab.attemptID === readyAttemptID) return state;
  return updateWorkspaceTabState(state, { ...tab, attemptID: readyAttemptID });
}

export type ClosedWorkspaceTab = {
  state: ProjectWorkspaceState;
  next?: WorkspaceTab;
  closed: boolean;
};

export function closeWorkspaceTabState(
  state: ProjectWorkspaceState,
  tabID: string,
): ClosedWorkspaceTab {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === tabID);
  if (closingIndex < 0) return { state, closed: false };
  const tabs = state.tabs.filter((tab) => tab.id !== tabID);
  const activeTabID =
    state.activeTabID === tabID
      ? (tabs[Math.min(closingIndex, tabs.length - 1)]?.id ?? tabs.at(-1)?.id)
      : state.activeTabID;
  const next = tabs.find((tab) => tab.id === activeTabID);
  return {
    state: { tabs, ...(activeTabID ? { activeTabID } : {}) },
    ...(next ? { next } : {}),
    closed: true,
  };
}
