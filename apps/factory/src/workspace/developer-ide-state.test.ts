import { expect, test } from "bun:test";
import {
  applyEditorObservedReady,
  applySourceChecked,
  applySourceObserved,
  beginSourceCheck,
  beginSourceObservation,
  createDeveloperIDESession,
  createWaitTimers,
  editorFrameOverlayMessage,
  editorPlaceholderMessage,
  finishEditorRestarting,
  initialEditorPhase,
  initialSourcePhase,
  markEditorFailed,
  markEditorReadyMessage,
  markEditorRestarting,
  markEditorWorkspaceSelected,
  postWorkspaceSelection,
  resetEditorForScopeChange,
  resumeEditorFromFailure,
  setEditorSlowPhase,
  sourceWaitDetailMessage,
} from "./developer-ide-state";

test("editor phase transitions preserve attachment across ready, failure, resume, and restart", () => {
  const preparing = initialEditorPhase();
  expect(editorPlaceholderMessage(preparing)).toBe("Preparing your editor…");

  const loaded = applyEditorObservedReady(preparing, 7, "ready");
  expect(loaded.changedEpoch).toBe(true);
  expect(loaded.phase.kind).toBe("loading-frame");
  expect(editorFrameOverlayMessage(loaded.phase)).toBe("Opening your editor…");

  const slow = setEditorSlowPhase(loaded.phase, true);
  expect(editorFrameOverlayMessage(slow)).toContain("still opening");

  const ready = markEditorWorkspaceSelected(markEditorReadyMessage(slow), "ws-1");
  expect(ready.kind).toBe("ready");
  expect(ready.kind === "ready" && ready.selectedWorkspaceID).toBe("ws-1");

  const failed = markEditorFailed(ready, "Connection dropped");
  expect(failed.kind).toBe("failed");
  expect(failed.kind === "failed" && failed.wasReady).toBe(true);

  const resumed = resumeEditorFromFailure(failed);
  expect(resumed.kind).toBe("ready");
  expect(resumed.kind === "ready" && resumed.selectedWorkspaceID).toBe("ws-1");

  const restarting = markEditorRestarting(resumed);
  expect(editorPlaceholderMessage(restarting)).toBe("Restarting your editor…");
  expect(finishEditorRestarting(restarting).kind).toBe("preparing");
  expect(resetEditorForScopeChange(restarting).kind).toBe("preparing");
});

test("source phase transitions handle paused, ready, terminal, and check flows", () => {
  const idle = initialSourcePhase();
  const observing = beginSourceObservation(idle, "ws-1", true);
  expect(observing.kind).toBe("observing");

  const paused = applySourceObserved(observing, "ws-1", {
    workspaceID: "ws-1",
    serviceID: "src-1",
    epoch: 1,
    state: "paused",
    failure: null,
  });
  expect(paused.done).toBe(true);
  expect(paused.phase.kind).toBe("available");
  expect(sourceWaitDetailMessage("paused")).toContain("resume compute");

  const checking = beginSourceCheck(observing, "ws-1", 1);
  expect(checking.kind).toBe("checking");
  expect(checking.checkMessage).toContain("check 1");

  const checked = applySourceChecked(
    "ws-1",
    {
      workspaceID: "ws-1",
      serviceID: "src-1",
      epoch: 1,
      state: "preparing",
      failure: null,
    },
    1,
  );
  expect(checked.retryObservation).toBe(true);
  expect(checked.phase.kind).toBe("observing");

  const stopped = applySourceObserved(observing, "ws-1", {
    workspaceID: "ws-1",
    serviceID: "src-1",
    epoch: 1,
    state: "stopped",
    failure: null,
  });
  expect(stopped.done).toBe(true);
  expect(stopped.phase.kind).toBe("unavailable");
});

test("developer IDE session manages abort slots, scope transitions, admission, and navigation", () => {
  const session = createDeveloperIDESession();
  expect(session.syncEditorScope("p1", true)).toBe(true);
  expect(session.syncEditorScope("p1", true)).toBe(false);
  expect(session.syncEditorScope("p2", true)).toBe(true);

  expect(session.consumeEditorAdmission(0)).toBe(true);
  expect(session.consumeEditorAdmission(0)).toBe(false);
  expect(session.consumeEditorAdmission(1)).toBe(true);

  expect(session.markNavigationSent("nav-1")).toBe(true);
  expect(session.markNavigationSent("nav-1")).toBe(false);
  session.resetNavigation();
  expect(session.markNavigationSent("nav-1")).toBe(true);

  const first = session.start("frameReload");
  const second = session.start("frameReload");
  expect(session.clearIfCurrent("frameReload", first)).toBe(false);
  expect(session.clearIfCurrent("frameReload", second)).toBe(true);

  const active = session.start("sourceObservation");
  session.abortAll();
  expect(active.signal.aborted).toBe(true);
});

test("createWaitTimers never binds browser-style timer functions to the timers object", async () => {
  const controller = new AbortController();
  const timers = createWaitTimers({
    setTimeout(this: unknown, callback) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      queueMicrotask(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    },
  });
  await expect(timers.pause(controller.signal)).resolves.toBeUndefined();
});

test("postWorkspaceSelection suppresses redundant selection messages once confirmed", () => {
  const posted: Array<{ message: unknown; origin: string }> = [];
  const frame = {
    contentWindow: {
      postMessage(message: unknown, origin: string) {
        posted.push({ message, origin });
      },
    },
  } as unknown as HTMLIFrameElement;

  postWorkspaceSelection(frame, "https://editor.example", true, true, true, "ws-1", "ws-1");
  expect(posted).toEqual([
    {
      message: { type: "factory:select-workspace", workspaceID: "ws-1" },
      origin: "https://editor.example",
    },
  ]);

  // Already confirmed by the IDE (e.g. tab switch or source refresh): do not re-post.
  postWorkspaceSelection(frame, "https://editor.example", true, true, true, "ws-1", "ws-1", "ws-1");
  expect(posted).toHaveLength(1);

  // Switching to a different Workspace still posts the new selection.
  postWorkspaceSelection(frame, "https://editor.example", true, true, true, "ws-2", "ws-2", "ws-1");
  expect(posted).toHaveLength(2);
  expect(posted[1]).toEqual({
    message: { type: "factory:select-workspace", workspaceID: "ws-2" },
    origin: "https://editor.example",
  });
});
