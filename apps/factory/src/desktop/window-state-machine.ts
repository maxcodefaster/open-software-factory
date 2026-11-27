import type { DesktopBackgroundKey } from "#interface-domain/background";
import type { WorkspaceView } from "../workspace-tabs";

export type DesktopMenuOverlay = "none" | "project-menu" | "settings-menu";
export type DesktopOverlay = DesktopMenuOverlay | "agent-overlay";

export interface DesktopChromeState {
  readonly activeMenu: DesktopMenuOverlay;
  readonly narrowViewport: boolean;
}

export type DesktopChromeEvent =
  | { type: "toggle-menu"; menu: Exclude<DesktopMenuOverlay, "none"> }
  | { type: "set-menu"; menu: DesktopMenuOverlay }
  | { type: "close-menus" }
  | { type: "viewport-changed"; narrow: boolean }
  | { type: "agent-overlay-opened" };

export function createInitialDesktopChromeState(): DesktopChromeState {
  return {
    activeMenu: "none",
    narrowViewport: false,
  };
}

export function transitionDesktopChrome(
  state: DesktopChromeState,
  event: DesktopChromeEvent,
): DesktopChromeState {
  switch (event.type) {
    case "toggle-menu":
      return {
        ...state,
        activeMenu: state.activeMenu === event.menu ? "none" : event.menu,
      };
    case "set-menu":
      return state.activeMenu === event.menu ? state : { ...state, activeMenu: event.menu };
    case "close-menus":
      return state.activeMenu === "none" ? state : { ...state, activeMenu: "none" };
    case "viewport-changed":
      return {
        activeMenu: "none",
        narrowViewport: event.narrow,
      };
    case "agent-overlay-opened":
      return state.activeMenu === "none" ? state : { ...state, activeMenu: "none" };
  }
}

export function isAgentOverlay(state: DesktopChromeState, agentOpen: boolean): boolean {
  return agentOpen && state.narrowViewport;
}

export function resolveActiveOverlay(
  state: DesktopChromeState,
  agentOpen: boolean,
): DesktopOverlay {
  if (state.activeMenu !== "none") return state.activeMenu;
  if (isAgentOverlay(state, agentOpen)) return "agent-overlay";
  return "none";
}

export interface DesktopDomRefs {
  workspaceElement: HTMLElement | undefined;
  desktopElement: HTMLElement | undefined;
  noticesElement: HTMLDivElement | undefined;
  projectControlElement: HTMLDivElement | undefined;
  settingsControlElement: HTMLDivElement | undefined;
  projectPopover: HTMLElement | undefined;
  settingsPopover: HTMLElement | undefined;
  agentPanelElement: HTMLElement | undefined;
  agentToggleElement: HTMLButtonElement | undefined;
}

export function createDesktopDomRefs(): DesktopDomRefs {
  return {
    workspaceElement: undefined,
    desktopElement: undefined,
    noticesElement: undefined,
    projectControlElement: undefined,
    settingsControlElement: undefined,
    projectPopover: undefined,
    settingsPopover: undefined,
    agentPanelElement: undefined,
    agentToggleElement: undefined,
  };
}

export interface FocusOpenerState {
  workspace: HTMLElement | undefined;
  agentOverlay: HTMLElement | undefined;
}

export function createFocusOpenerState(): FocusOpenerState {
  return {
    workspace: undefined,
    agentOverlay: undefined,
  };
}

export interface BackgroundPickerState {
  readonly firstKey: DesktopBackgroundKey;
  readonly expanded: boolean;
}

export function createBackgroundPickerState(firstKey: DesktopBackgroundKey): BackgroundPickerState {
  return { firstKey, expanded: false };
}

export function updateBackgroundPickerExpanded(
  state: BackgroundPickerState,
  next: boolean | ((previous: boolean) => boolean),
): BackgroundPickerState {
  const expanded = typeof next === "function" ? next(state.expanded) : next;
  return expanded === state.expanded ? state : { ...state, expanded };
}

export function shouldRestoreWorkspaceFocus(
  nextVisible: boolean,
  wasVisible: boolean,
  focusInsideWorkspaceOrBody: boolean,
): boolean {
  return !nextVisible && wasVisible && focusInsideWorkspaceOrBody;
}

export function selectWorkspaceFocusSelector(view: WorkspaceView | undefined): string | null {
  if (view === "ticket-draft") return '[aria-label="Ticket title"]';
  if (view === "ticket") return "article.ticket-document:not([hidden])";
  return null;
}

export function shouldCancelWorkspaceFocusHandoff(params: {
  panelContainsActive: boolean;
  activeMenu: DesktopMenuOverlay;
  activeIsExternalControl: boolean;
}): boolean {
  return (
    params.panelContainsActive || params.activeMenu !== "none" || params.activeIsExternalControl
  );
}

export function resolveDesktopTitle(
  tabLabel: string | undefined,
  projectName: string | undefined,
): string {
  return [tabLabel, projectName, "Open Software Factory"].filter(Boolean).join(" · ");
}

export function resolveNoticesInset(children: Iterable<Element>): string {
  const lasting = Array.from(children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.hasAttribute("data-transient"),
  );
  const last = lasting.at(-1);
  return last ? `${last.offsetTop + last.offsetHeight + 8}px` : "0px";
}

export function isFocusableElement(element: HTMLElement | undefined): boolean {
  return Boolean(
    element?.isConnected && !element.closest("[inert]") && element.getClientRects().length > 0,
  );
}

export function deferEffect(
  schedule: (callback: () => void) => void,
  setup: (signal: AbortSignal) => (() => void) | undefined,
): () => void {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  schedule(() => {
    if (controller.signal.aborted) return;
    const teardown = setup(controller.signal);
    if (teardown) cleanups.push(teardown);
  });
  return () => {
    controller.abort();
    for (const teardown of cleanups.splice(0)) teardown();
  };
}

export interface DesktopLifecycleGuard {
  disposed: boolean;
  ticketReadGeneration: number;
  bumpTicketReadGeneration(): number;
  beginModelAvailabilityRead(): number;
  isCurrentModelAvailabilityRead(generation: number): boolean;
  dispose(): void;
}

export function createDesktopLifecycleGuard(): DesktopLifecycleGuard {
  const state = {
    disposed: false,
    ticketReadGeneration: 0,
    modelAvailabilityReadGeneration: 0,
  };
  return {
    get disposed() {
      return state.disposed;
    },
    set disposed(value: boolean) {
      state.disposed = value;
    },
    get ticketReadGeneration() {
      return state.ticketReadGeneration;
    },
    set ticketReadGeneration(value: number) {
      state.ticketReadGeneration = value;
    },
    bumpTicketReadGeneration() {
      state.ticketReadGeneration += 1;
      return state.ticketReadGeneration;
    },
    beginModelAvailabilityRead() {
      state.modelAvailabilityReadGeneration += 1;
      return state.modelAvailabilityReadGeneration;
    },
    isCurrentModelAvailabilityRead(generation: number) {
      return !state.disposed && generation === state.modelAvailabilityReadGeneration;
    },
    dispose() {
      state.disposed = true;
    },
  };
}
