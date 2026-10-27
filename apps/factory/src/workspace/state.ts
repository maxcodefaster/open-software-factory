import { type Accessor, createSignal } from "solid-js";
import {
  closeWorkspaceTabState,
  followStagingPromotion,
  openWorkspaceTabState,
  type ProjectWorkspaceState,
  updateWorkspaceTabState,
  type WorkspaceTab,
} from "../workspace-tabs";

// The URL selects a resource. It never owns the other open tabs or their drafts.
export function createWorkspaceState(projectID: Accessor<string | undefined>) {
  const [states, setStates] = createSignal<Record<string, ProjectWorkspaceState>>({});
  const current = () => states()[projectID() ?? "factory"];
  const tabs = () => current()?.tabs ?? [];
  function updateCurrent(update: (state: ProjectWorkspaceState) => ProjectWorkspaceState) {
    const key = projectID() ?? "factory";
    setStates((all) => ({ ...all, [key]: update(all[key] ?? { tabs: [] }) }));
  }
  return {
    states,
    current,
    tabs,
    open(tab: WorkspaceTab) {
      updateCurrent((state) => openWorkspaceTabState(state, tab));
    },
    activate(tab: WorkspaceTab) {
      updateCurrent((state) => ({ ...state, activeTabID: tab.id }));
    },
    update(tab: WorkspaceTab, key = projectID()) {
      if (!key) return;
      setStates((all) => ({
        ...all,
        [key]: updateWorkspaceTabState(all[key] ?? { tabs: [] }, tab),
      }));
    },
    close(tabID: string) {
      const state = current();
      if (!state) return;
      const result = closeWorkspaceTabState(state, tabID);
      if (result.closed) updateCurrent(() => result.state);
      return result;
    },
    followStaging(key: string, readyAttemptID: string | undefined) {
      setStates((all) => {
        const state = all[key];
        if (!state) return all;
        const next = followStagingPromotion(state, key, readyAttemptID);
        return next === state ? all : { ...all, [key]: next };
      });
    },
  };
}
