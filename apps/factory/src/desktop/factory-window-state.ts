import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { createEffect, createMemo, createSignal, onSettled, untrack } from "solid-js";
import type { DesktopBackgroundKey } from "#interface-domain/background";
import { type FactoryZeroContext, type FactoryZeroSchema, zeroMutators } from "#zero-schema";
import type { useZero } from "#zero-solid";
import { orderedDesktopBackgrounds } from "../artworks";
import { plainErrorMessage } from "../command-error";
import { bindPopoverKeyboard } from "../popover-keyboard";
import { createWindowPresence } from "../window-presence";
import { workspacePanelID, workspaceTabElementID } from "../workspace-tabbar";
import { type ProjectWorkspaceState, selectedWorkspaceTab } from "../workspace-tabs";
import type { DesktopProject } from "./contracts";
import { createDesktopFocusController } from "./window-focus";
import {
  createBackgroundPickerState,
  createDesktopDomRefs,
  createFocusOpenerState,
  createInitialDesktopChromeState,
  type DesktopChromeEvent,
  type DesktopMenuOverlay,
  deferEffect,
  isAgentOverlay,
  resolveActiveOverlay,
  resolveDesktopTitle,
  resolveNoticesInset,
  selectWorkspaceFocusSelector,
  shouldCancelWorkspaceFocusHandoff,
  transitionDesktopChrome,
  updateBackgroundPickerExpanded,
} from "./window-state-machine";

export type { DesktopMenuOverlay, DesktopOverlay } from "./window-state-machine";

export async function commitZeroMutation(operation: Promise<unknown>) {
  const result = await operation;
  if (
    result &&
    typeof result === "object" &&
    "type" in result &&
    result.type === "error" &&
    "error" in result &&
    result.error &&
    typeof result.error === "object" &&
    "message" in result.error
  ) {
    throw new Error(String(result.error.message));
  }
}

export interface FactoryWindowStateDependencies {
  currentWorkspaceState: Accessor<ProjectWorkspaceState | undefined>;
  selectedProjectID: SourceAccessor<string | undefined>;
  selectedProject: Accessor<DesktopProject | undefined>;
  projectMenuOpen: SourceAccessor<boolean>;
  setProjectMenuOpen: Setter<boolean>;
  canManageProject: () => boolean;
  defaultBackgroundKey: () => DesktopBackgroundKey;
  zero: ReturnType<typeof useZero<FactoryZeroSchema, undefined, FactoryZeroContext>>;
  setError: Setter<string>;
}

export function createFactoryWindowState(dependencies: FactoryWindowStateDependencies) {
  const workspaceWindow = createWindowPresence();
  const { visible: workspaceVisible } = workspaceWindow;
  const [workspaceFocusTarget, setWorkspaceFocusTarget] = createSignal<string>();
  const agentPresence = createWindowPresence();
  const { visible: agentOpen, setVisible: setAgentOpen } = agentPresence;
  const [chrome, setChrome] = createSignal(createInitialDesktopChromeState());
  const refs = createDesktopDomRefs();
  const openers = createFocusOpenerState();

  function dispatchChrome(event: DesktopChromeEvent) {
    const next = transitionDesktopChrome(untrack(chrome), event);
    setChrome(next);
    dependencies.setProjectMenuOpen(next.activeMenu === "project-menu");
    return next;
  }

  const activeMenu = createMemo(() => chrome().activeMenu);
  const narrowViewport = createMemo(() => chrome().narrowViewport);
  const agentOverlay = createMemo(() => isAgentOverlay(chrome(), agentOpen()));
  const activeOverlay = createMemo(() => resolveActiveOverlay(chrome(), agentOpen()));
  const projectMenuOpen = () => activeMenu() === "project-menu";
  const settingsOpen = () => activeMenu() === "settings-menu";

  const setActiveMenu = (menu: DesktopMenuOverlay) => dispatchChrome({ type: "set-menu", menu });
  const toggleMenu = (menu: Exclude<DesktopMenuOverlay, "none">) =>
    dispatchChrome({ type: "toggle-menu", menu });
  const closeMenus = () => dispatchChrome({ type: "close-menus" });

  function setProjectMenuOpen(value: boolean | ((previous: boolean) => boolean)) {
    const next = typeof value === "function" ? value(untrack(projectMenuOpen)) : value;
    if (next) setActiveMenu("project-menu");
    else if (untrack(activeMenu) === "project-menu") closeMenus();
    return next;
  }

  function setSettingsOpen(value: boolean | ((previous: boolean) => boolean)) {
    const next = typeof value === "function" ? value(untrack(settingsOpen)) : value;
    if (next) setActiveMenu("settings-menu");
    else if (untrack(activeMenu) === "settings-menu") closeMenus();
    return next;
  }

  const focus = createDesktopFocusController({
    refs,
    openers,
    workspaceWindow,
    agentOpen,
    setAgentOpen,
    setWorkspaceFocusTarget,
  });

  const activeWorkspaceTab = () => {
    if (!workspaceWindow.present()) return undefined;
    return selectedWorkspaceTab(dependencies.currentWorkspaceState());
  };
  const workspaceView = () => activeWorkspaceTab()?.view;
  const activeWorkspaceLabelID = () => {
    const tab = activeWorkspaceTab();
    return tab ? workspaceTabElementID(tab.id) : undefined;
  };

  // Lasting notices take layout space so they never hide the window tab bar or Board controls.
  onSettled(() => {
    const root = refs.desktopElement;
    const notices = refs.noticesElement;
    if (!root || !notices) return;
    const measure = () => {
      root.style.setProperty("--notices-inset", resolveNoticesInset(notices.children));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(notices);
    measure();
    return () => {
      observer.disconnect();
      root.style.removeProperty("--notices-inset");
    };
  });

  onSettled(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => {
      if (query.matches && agentOpen()) focus.rememberAgentOpener();
      dispatchChrome({ type: "viewport-changed", narrow: query.matches });
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });

  onSettled(() => {
    const closeTransientMenus = (event: PointerEvent) => {
      const menu = activeMenu();
      const target = event.target as Node | null;
      if (menu !== "none" && target && !focus.activeMenuControl(menu)?.contains(target)) {
        closeMenus();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const opener = focus.activeMenuOpener(activeMenu());
      if (!opener) return;
      event.preventDefault();
      closeMenus();
      opener.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", closeTransientMenus, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeTransientMenus, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  });

  createEffect(
    () => agentOverlay(),
    (overlay) => {
      if (!overlay) return;
      dispatchChrome({ type: "agent-overlay-opened" });
      return deferEffect(queueMicrotask, () => {
        const element = refs.agentPanelElement;
        const keydown = (event: KeyboardEvent) => {
          if (
            event.defaultPrevented ||
            event.key !== "Escape" ||
            !(event.target instanceof Node) ||
            !element?.contains(event.target)
          )
            return;
          event.preventDefault();
          focus.dismissAgent();
        };
        // Let Solid's delegated help/menu handlers consume Escape before dismissing the panel.
        document.addEventListener("keydown", keydown);
        if (element && !element.contains(document.activeElement)) {
          const inputs = element.querySelectorAll<HTMLElement>(
            'textarea:not(:disabled), input:not(:disabled):not([type="file"]):not([type="hidden"])',
          );
          (
            [...inputs].find((input) => input.getClientRects().length) ??
            element.querySelector<HTMLElement>("button:not(:disabled)")
          )?.focus({ preventScroll: true });
        }
        return () => document.removeEventListener("keydown", keydown);
      });
    },
  );

  createEffect(
    () => activeMenu(),
    (menu) => {
      if (menu === "none") return;
      return deferEffect(queueMicrotask, () => {
        const element = focus.activeMenuPopover(menu);
        return element
          ? bindPopoverKeyboard(element, focus.activeMenuOpener(menu), closeMenus)
          : undefined;
      });
    },
  );

  createEffect(
    () => [workspaceVisible(), activeWorkspaceTab()?.id, workspaceFocusTarget()] as const,
    ([visible, id, requested]) => {
      if (!visible || !id || requested !== id) return;
      return deferEffect(onSettled, (signal) => {
        const panel = document.getElementById(workspacePanelID);
        if (!panel) return undefined;
        const handoff = () => {
          if (signal.aborted || !workspaceVisible() || activeWorkspaceTab()?.id !== id) return;
          const active = document.activeElement;
          // A late document read must not steal a later control's focus.
          if (
            shouldCancelWorkspaceFocusHandoff({
              panelContainsActive: panel.contains(active),
              activeMenu: activeMenu(),
              activeIsExternalControl:
                active instanceof HTMLElement &&
                active !== document.body &&
                active !== openers.workspace,
            })
          ) {
            setWorkspaceFocusTarget(undefined);
            return;
          }
          const selector = selectWorkspaceFocusSelector(activeWorkspaceTab()?.view);
          const target = selector ? panel.querySelector<HTMLElement>(selector) : panel;
          if (!target || target.closest("[inert]")) return;
          target.focus({ preventScroll: true });
          setWorkspaceFocusTarget(undefined);
        };
        const observer = new MutationObserver(handoff);
        observer.observe(panel, { childList: true, subtree: true });
        handoff();
        return () => observer.disconnect();
      });
    },
  );

  createEffect(
    () =>
      [
        workspaceVisible() ? activeWorkspaceTab()?.label : undefined,
        dependencies.selectedProject()?.name,
      ] as const,
    ([tab, project]) => {
      document.title = resolveDesktopTitle(tab, project);
    },
  );

  const desktopBackgroundKey = () =>
    dependencies.selectedProject()?.desktopBackgroundKey ?? dependencies.defaultBackgroundKey();
  const [backgroundSaves, setBackgroundSaves] = createSignal<Record<string, boolean>>({});
  const [backgroundPicker, setBackgroundPicker] = createSignal(
    createBackgroundPickerState(untrack(dependencies.defaultBackgroundKey)),
  );
  const backgroundPickerExpanded = () => backgroundPicker().expanded;
  const setBackgroundPickerExpanded = (value: boolean | ((previous: boolean) => boolean)) =>
    setBackgroundPicker((current) => updateBackgroundPickerExpanded(current, value)).expanded;
  const backgroundChoices = createMemo(() =>
    orderedDesktopBackgrounds(backgroundPicker().firstKey),
  );

  createEffect(
    () => [settingsOpen(), dependencies.selectedProjectID()] as const,
    ([open]) => {
      if (!open) return;
      // Snapshot on open, not on selection, so saving never moves the focused choice.
      setBackgroundPicker(createBackgroundPickerState(untrack(desktopBackgroundKey)));
    },
  );

  async function chooseDesktopBackground(key: DesktopBackgroundKey) {
    const project = dependencies.selectedProject();
    const client = dependencies.zero();
    if (!project || !client || !dependencies.canManageProject() || backgroundSaves()[project.id])
      return;
    if (key === project.desktopBackgroundKey) return;
    setBackgroundSaves((current) => ({ ...current, [project.id]: true }));
    try {
      await commitZeroMutation(
        client.mutate(
          zeroMutators.projects.setBackground({
            projectId: project.id,
            desktopBackgroundKey: key,
          }),
        ).server,
      );
    } catch (cause) {
      dependencies.setError(
        `Background for ${project.name} could not be saved. ${
          cause instanceof Error ? plainErrorMessage(cause.message) : "Try again."
        }`,
      );
    } finally {
      setBackgroundSaves((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
    }
  }

  return {
    workspaceWindow,
    workspaceVisible,
    setWorkspaceVisible: focus.setWorkspaceVisible,
    workspaceFocusTarget,
    setWorkspaceFocusTarget,
    activeWorkspaceTab,
    workspaceView,
    activeWorkspaceLabelID,
    agentPresence,
    agentOpen,
    setAgentOpen,
    narrowViewport,
    agentOverlay,
    activeMenu,
    activeOverlay,
    setActiveMenu,
    toggleMenu,
    closeMenus,
    projectMenuOpen,
    setProjectMenuOpen,
    settingsOpen,
    setSettingsOpen,
    captureWorkspaceOpener: focus.captureWorkspaceOpener,
    captureSettingsOpener: focus.captureSettingsOpener,
    captureReopenOpener: focus.captureReopenOpener,
    rememberAgentOpener: focus.rememberAgentOpener,
    dismissAgent: focus.dismissAgent,
    desktopBackgroundKey,
    backgroundSaves,
    backgroundPickerExpanded,
    setBackgroundPickerExpanded,
    backgroundChoices,
    chooseDesktopBackground,
    refs,
  };
}
