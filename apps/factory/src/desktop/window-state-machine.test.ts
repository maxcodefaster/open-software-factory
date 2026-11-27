import { describe, expect, test } from "bun:test";
import {
  createBackgroundPickerState,
  createDesktopLifecycleGuard,
  createInitialDesktopChromeState,
  deferEffect,
  isAgentOverlay,
  resolveActiveOverlay,
  resolveDesktopTitle,
  selectWorkspaceFocusSelector,
  shouldCancelWorkspaceFocusHandoff,
  shouldRestoreWorkspaceFocus,
  transitionDesktopChrome,
  updateBackgroundPickerExpanded,
} from "./window-state-machine";

describe("DesktopChromeState overlay state machine", () => {
  test("mutually exclusive menus toggle and switch cleanly without invalid overlap", () => {
    const initial = createInitialDesktopChromeState();
    expect(initial).toEqual({ activeMenu: "none", narrowViewport: false });

    const projectOpen = transitionDesktopChrome(initial, {
      type: "toggle-menu",
      menu: "project-menu",
    });
    expect(projectOpen.activeMenu).toBe("project-menu");

    // Opening settings atomically replaces project-menu so both can never be open.
    const settingsOpen = transitionDesktopChrome(projectOpen, {
      type: "toggle-menu",
      menu: "settings-menu",
    });
    expect(settingsOpen.activeMenu).toBe("settings-menu");

    // Toggling the already-open menu closes it.
    const closed = transitionDesktopChrome(settingsOpen, {
      type: "toggle-menu",
      menu: "settings-menu",
    });
    expect(closed.activeMenu).toBe("none");
  });

  test("viewport change and agent-overlay opening close any active menu", () => {
    const settingsOpen = transitionDesktopChrome(createInitialDesktopChromeState(), {
      type: "set-menu",
      menu: "settings-menu",
    });
    const narrow = transitionDesktopChrome(settingsOpen, {
      type: "viewport-changed",
      narrow: true,
    });
    expect(narrow).toEqual({ activeMenu: "none", narrowViewport: true });

    const projectOnNarrow = transitionDesktopChrome(narrow, {
      type: "set-menu",
      menu: "project-menu",
    });
    const overlayOpened = transitionDesktopChrome(projectOnNarrow, {
      type: "agent-overlay-opened",
    });
    expect(overlayOpened).toEqual({ activeMenu: "none", narrowViewport: true });
  });

  test("activeOverlay reflects menu precedence over narrow agent overlay and wide side panel", () => {
    const wide = createInitialDesktopChromeState();
    expect(isAgentOverlay(wide, true)).toBe(false);
    expect(resolveActiveOverlay(wide, true)).toBe("none");

    const narrow = transitionDesktopChrome(wide, { type: "viewport-changed", narrow: true });
    expect(isAgentOverlay(narrow, true)).toBe(true);
    expect(resolveActiveOverlay(narrow, true)).toBe("agent-overlay");
    expect(resolveActiveOverlay(narrow, false)).toBe("none");

    const narrowWithSettings = transitionDesktopChrome(narrow, {
      type: "set-menu",
      menu: "settings-menu",
    });
    expect(resolveActiveOverlay(narrowWithSettings, true)).toBe("settings-menu");
  });
});

describe("Window focus, title, background picker and lifecycle helpers", () => {
  test("workspace focus restoration and handoff guards", () => {
    expect(shouldRestoreWorkspaceFocus(false, true, true)).toBe(true);
    expect(shouldRestoreWorkspaceFocus(false, false, true)).toBe(false);
    expect(shouldRestoreWorkspaceFocus(true, false, true)).toBe(false);
    expect(shouldRestoreWorkspaceFocus(false, true, false)).toBe(false);

    expect(selectWorkspaceFocusSelector("ticket-draft")).toBe('[aria-label="Ticket title"]');
    expect(selectWorkspaceFocusSelector("ticket")).toBe("article.ticket-document:not([hidden])");
    expect(selectWorkspaceFocusSelector("knowledge")).toBeNull();
    expect(selectWorkspaceFocusSelector(undefined)).toBeNull();

    expect(
      shouldCancelWorkspaceFocusHandoff({
        panelContainsActive: false,
        activeMenu: "none",
        activeIsExternalControl: false,
      }),
    ).toBe(false);
    expect(
      shouldCancelWorkspaceFocusHandoff({
        panelContainsActive: false,
        activeMenu: "project-menu",
        activeIsExternalControl: false,
      }),
    ).toBe(true);
    expect(
      shouldCancelWorkspaceFocusHandoff({
        panelContainsActive: true,
        activeMenu: "none",
        activeIsExternalControl: false,
      }),
    ).toBe(true);
  });

  test("resolveDesktopTitle formats non-empty segments", () => {
    expect(resolveDesktopTitle("Ticket A", "Alpha")).toBe(
      "Ticket A · Alpha · Open Software Factory",
    );
    expect(resolveDesktopTitle(undefined, "Alpha")).toBe("Alpha · Open Software Factory");
    expect(resolveDesktopTitle(undefined, undefined)).toBe("Open Software Factory");
  });

  test("background picker state snapshots firstKey and toggles expanded", () => {
    const picker = createBackgroundPickerState("the-harvesters");
    expect(picker).toEqual({ firstKey: "the-harvesters", expanded: false });
    const expanded = updateBackgroundPickerExpanded(picker, (value) => !value);
    expect(expanded).toEqual({ firstKey: "the-harvesters", expanded: true });
    expect(updateBackgroundPickerExpanded(expanded, true)).toBe(expanded);
  });

  test("deferEffect cancels before scheduled execution and runs teardown after execution", () => {
    const queue: Array<() => void> = [];
    const schedule = (callback: () => void) => {
      queue.push(callback);
    };

    let ran = false;
    const cancelEarly = deferEffect(schedule, () => {
      ran = true;
      return undefined;
    });
    cancelEarly();
    for (const callback of queue.splice(0)) callback();
    expect(ran).toBe(false);

    let tornDown = false;
    const cancelAfter = deferEffect(schedule, (signal) => {
      expect(signal.aborted).toBe(false);
      return () => {
        tornDown = true;
      };
    });
    for (const callback of queue.splice(0)) callback();
    expect(tornDown).toBe(false);
    cancelAfter();
    expect(tornDown).toBe(true);
  });

  test("DesktopLifecycleGuard tracks read generations and disposal", () => {
    const guard = createDesktopLifecycleGuard();
    expect(guard.disposed).toBe(false);
    expect(guard.bumpTicketReadGeneration()).toBe(1);
    expect(guard.ticketReadGeneration).toBe(1);

    const first = guard.beginModelAvailabilityRead();
    const second = guard.beginModelAvailabilityRead();
    expect(guard.isCurrentModelAvailabilityRead(first)).toBe(false);
    expect(guard.isCurrentModelAvailabilityRead(second)).toBe(true);

    guard.dispose();
    expect(guard.disposed).toBe(true);
    expect(guard.isCurrentModelAvailabilityRead(second)).toBe(false);
  });
});
