import type { Accessor, Setter } from "solid-js";
import { untrack } from "solid-js";
import type { createWindowPresence } from "../window-presence";
import {
  type DesktopDomRefs,
  type DesktopMenuOverlay,
  type FocusOpenerState,
  isFocusableElement,
  shouldRestoreWorkspaceFocus,
} from "./window-state-machine";

export interface DesktopFocusControllerOptions {
  refs: DesktopDomRefs;
  openers: FocusOpenerState;
  workspaceWindow: ReturnType<typeof createWindowPresence>;
  agentOpen: Accessor<boolean>;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  setWorkspaceFocusTarget: Setter<string | undefined>;
}

export function createDesktopFocusController(options: DesktopFocusControllerOptions) {
  const { refs, openers, workspaceWindow, agentOpen, setAgentOpen, setWorkspaceFocusTarget } =
    options;
  const { visible: workspaceVisible } = workspaceWindow;

  function setWorkspaceVisible(value: boolean) {
    const restore = shouldRestoreWorkspaceFocus(
      value,
      untrack(workspaceVisible),
      Boolean(
        refs.workspaceElement?.contains(document.activeElement) ||
          document.activeElement === document.body,
      ),
    );
    workspaceWindow.setVisible(value);
    if (!value) setWorkspaceFocusTarget(undefined);
    if (restore)
      requestAnimationFrame(() => {
        if (workspaceVisible()) return;
        // Cached Board updates and responsive navigation can replace the original button.
        const label = openers.workspace?.getAttribute("aria-label");
        const replacement = label
          ? Array.from(
              document.querySelectorAll<HTMLElement>(`button[aria-label="${CSS.escape(label)}"]`),
            ).find(isFocusableElement)
          : undefined;
        const target = isFocusableElement(openers.workspace)
          ? openers.workspace
          : (replacement ??
            document.querySelector<HTMLElement>('.workspace-dock button[aria-label="Desktop"]'));
        target?.focus({ preventScroll: true });
      });
  }

  function captureWorkspaceOpener() {
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      !refs.workspaceElement?.contains(document.activeElement)
    )
      openers.workspace = document.activeElement;
  }

  function captureSettingsOpener() {
    if (refs.settingsControlElement?.contains(document.activeElement))
      openers.workspace =
        refs.settingsControlElement.querySelector<HTMLButtonElement>("button") ?? openers.workspace;
  }

  function captureReopenOpener() {
    if (document.activeElement instanceof HTMLElement) openers.workspace = document.activeElement;
  }

  function rememberAgentOpener() {
    const active = document.activeElement;
    openers.agentOverlay =
      active instanceof HTMLElement && !refs.agentPanelElement?.contains(active)
        ? active
        : refs.agentToggleElement;
  }

  function dismissAgent() {
    const opener = openers.agentOverlay ?? refs.agentToggleElement;
    const openerBlocked = Boolean(opener?.closest("[inert]"));
    if (opener?.isConnected && !openerBlocked && opener.getClientRects().length)
      opener.focus({ preventScroll: true });
    // A disconnected, hidden or non-focusable opener must not leave focus in
    // the panel when its closing render applies aria-hidden and inert.
    const parked = openerBlocked || refs.agentPanelElement?.contains(document.activeElement);
    if (parked) refs.agentToggleElement?.focus({ preventScroll: true });
    setAgentOpen(false);
    // Narrow document openers are inert until that render closes the overlay.
    // Restore the original place only if no intervening interaction moved focus.
    if (parked && opener !== refs.agentToggleElement)
      requestAnimationFrame(() => {
        if (
          !agentOpen() &&
          opener?.isConnected &&
          document.activeElement === refs.agentToggleElement
        )
          opener.focus({ preventScroll: true });
      });
  }

  function projectMenuOpener(): HTMLButtonElement | undefined {
    const button =
      refs.projectControlElement?.querySelector<HTMLButtonElement>(".project-selector");
    return button?.getClientRects().length
      ? button
      : (refs.settingsControlElement?.querySelector<HTMLButtonElement>("button") ?? undefined);
  }

  function activeMenuControl(menu: DesktopMenuOverlay): HTMLElement | undefined {
    if (menu === "project-menu") return refs.projectControlElement;
    if (menu === "settings-menu") return refs.settingsControlElement;
    return undefined;
  }

  function activeMenuPopover(menu: DesktopMenuOverlay): HTMLElement | undefined {
    if (menu === "project-menu") return refs.projectPopover;
    if (menu === "settings-menu") return refs.settingsPopover;
    return undefined;
  }

  function activeMenuOpener(menu: DesktopMenuOverlay): HTMLButtonElement | undefined {
    if (menu === "project-menu") return projectMenuOpener();
    if (menu === "settings-menu")
      return refs.settingsControlElement?.querySelector<HTMLButtonElement>("button") ?? undefined;
    return undefined;
  }

  return {
    setWorkspaceVisible,
    captureWorkspaceOpener,
    captureSettingsOpener,
    captureReopenOpener,
    rememberAgentOpener,
    dismissAgent,
    activeMenuControl,
    activeMenuPopover,
    activeMenuOpener,
  };
}
