import type { DeveloperIDEState } from "#workspace-domain/developer-ide";
import { confirmAccessStopped } from "../access-stop";
import { plainErrorMessage } from "../command-error";
import type { WorkspaceSourceView } from "./contracts";
import {
  applyEditorObservedReady,
  applyEditorObservedState,
  type EditorPhase,
  finishEditorRestarting,
  markEditorFailed,
  markEditorRestartFailed,
  markEditorRestarting,
  resetEditorForScopeChange,
  resumeEditorFromFailure,
  setEditorReconnectingPhase,
  TERMINAL_STATES,
  tolerant,
} from "./developer-ide-model";
import type { DeveloperIDESession, WaitTimers } from "./developer-ide-session";
import {
  applySourceChecked,
  applySourceObserved,
  beginSourceCheck,
  beginSourceObservation,
  beginStartingSelection,
  finishSourceCheck,
  finishStartingSelection,
  markSourceUnavailable,
  resetSourceToIdle,
  type SourcePhase,
  setSourceReconnectingPhase,
} from "./developer-ide-source-model";

export type DeveloperIDEObserved = {
  epoch: number;
  state: DeveloperIDEState;
  failure?: string | null | undefined;
};

export function observeDeveloperIDE(options: {
  signal: AbortSignal;
  admit: boolean;
  timers: WaitTimers;
  session: DeveloperIDESession;
  ensure: (signal: AbortSignal) => Promise<DeveloperIDEObserved>;
  read: (signal: AbortSignal) => Promise<DeveloperIDEObserved>;
  setEditorPhase: (updater: (prev: EditorPhase) => EditorPhase) => void;
}) {
  const { signal, timers, session, ensure, read, setEditorPhase } = options;
  const onReconnecting = (value: boolean) =>
    setEditorPhase((prev) => setEditorReconnectingPhase(prev, value));
  const admission = { pending: options.admit };
  return (async () => {
    let current = await tolerant(
      signal,
      () => {
        if (!admission.pending) return read(signal);
        admission.pending = false;
        return ensure(signal);
      },
      onReconnecting,
      timers.outagePause,
    );
    while (!signal.aborted) {
      if (current.state === "ready") {
        const nextEpoch = current.epoch;
        const currentState = current.state;
        setEditorPhase((prev) => {
          const result = applyEditorObservedReady(prev, nextEpoch, currentState);
          if (result.changedEpoch) session.abort("frameReload");
          return result.phase;
        });
        return;
      }
      const observedState = current.state;
      setEditorPhase((prev) => applyEditorObservedState(prev, observedState));
      if (TERMINAL_STATES.has(observedState))
        throw new Error(current.failure ?? "Editor is stopped. Retry to prepare it.");
      await timers.pause(signal);
      current = await tolerant(signal, () => read(signal), onReconnecting, timers.outagePause);
    }
  })().catch((cause: unknown) => {
    if (!signal.aborted)
      setEditorPhase((prev) =>
        markEditorFailed(
          prev,
          cause instanceof Error ? plainErrorMessage(cause.message) : "Editor is unavailable.",
        ),
      );
  });
}

export function observeWorkspaceSource(options: {
  signal: AbortSignal;
  workspaceID: string;
  timers: WaitTimers;
  read: (signal: AbortSignal) => Promise<WorkspaceSourceView>;
  setSourcePhase: (updater: (prev: SourcePhase) => SourcePhase) => void;
}) {
  const { signal, workspaceID, timers, read, setSourcePhase } = options;
  const onReconnecting = (value: boolean) =>
    setSourcePhase((prev) => setSourceReconnectingPhase(prev, workspaceID, value));
  return (async () => {
    while (!signal.aborted) {
      const source = await tolerant(signal, () => read(signal), onReconnecting, timers.outagePause);
      if (signal.aborted) return;
      if (source.workspaceID !== workspaceID)
        throw new Error("File access returned a different Workspace. Nothing was selected.");
      const outcome = { done: false };
      setSourcePhase((prev) => {
        const next = applySourceObserved(prev, workspaceID, source);
        outcome.done = next.done;
        return next.phase;
      });
      if (outcome.done) return;
      await timers.pause(signal);
    }
  })().catch((cause: unknown) => {
    if (!signal.aborted)
      setSourcePhase((prev) =>
        markSourceUnavailable(
          prev,
          workspaceID,
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Workspace files are unavailable.",
          { preserveState: true },
        ),
      );
  });
}

export async function checkWorkspaceSource(options: {
  workspaceID: string;
  session: DeveloperIDESession;
  getSourcePhase: () => SourcePhase;
  setSourcePhase: (updater: (prev: SourcePhase) => SourcePhase) => void;
  isScopeStillActive: () => boolean;
  ensure: (signal: AbortSignal) => Promise<WorkspaceSourceView>;
  onRetryObservation: () => void;
}) {
  const {
    workspaceID,
    session,
    getSourcePhase,
    setSourcePhase,
    isScopeStillActive,
    ensure,
    onRetryObservation,
  } = options;
  const cancel = session.start("sourceRecovery");
  session.abort("sourceObservation");
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(150_000)]);
  const check = getSourcePhase().checks + 1;
  setSourcePhase((prev) => beginSourceCheck(prev, workspaceID, check));
  try {
    const source = await ensure(signal);
    signal.throwIfAborted();
    if (!isScopeStillActive()) return;
    if (source.workspaceID !== workspaceID)
      throw new Error(
        "The file access check returned a different Workspace. Nothing was selected.",
      );
    const next = applySourceChecked(workspaceID, source, check);
    setSourcePhase(() => next.phase);
    if (next.retryObservation) onRetryObservation();
  } catch (cause) {
    if (!cancel.signal.aborted) {
      setSourcePhase((prev) =>
        markSourceUnavailable(
          prev,
          workspaceID,
          signal.aborted
            ? "The file access check timed out. Keep your editor buffer; retry only checks the current Source."
            : cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "File access could not recover.",
          {
            checks: check,
            checkMessage: `File access check ${check}: not confirmed. Keep your unsaved edits.`,
          },
        ),
      );
    }
  } finally {
    if (session.clearIfCurrent("sourceRecovery", cancel)) setSourcePhase(finishSourceCheck);
  }
}

export async function restartDeveloperIDE(options: {
  projectID: string | undefined;
  allowed: boolean;
  editorRecovering: boolean;
  sourceRecovering: boolean;
  confirm?: () => boolean;
  session: DeveloperIDESession;
  timers: WaitTimers;
  setEditorPhase: (updater: (prev: EditorPhase) => EditorPhase) => void;
  isScopeStillActive: () => boolean;
  stop: (signal: AbortSignal) => Promise<unknown>;
  read: (signal: AbortSignal) => Promise<DeveloperIDEObserved>;
  onRestartConfirmed: () => void;
}) {
  if (
    !options.projectID ||
    !options.allowed ||
    options.editorRecovering ||
    options.sourceRecovering
  )
    return;
  const confirmed = options.confirm
    ? options.confirm()
    : window.confirm(
        "Restart your editor? Unsaved editor changes may be lost. Running Apps and Builds will continue.",
      );
  if (!confirmed) return;
  const { session, timers, setEditorPhase, isScopeStillActive, stop, read, onRestartConfirmed } =
    options;
  const cancel = session.start("editorRecovery");
  session.abort("frameReload");
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(150_000)]);
  setEditorPhase(markEditorRestarting);
  try {
    await confirmAccessStopped(
      signal,
      { stop, read, wait: timers.pause },
      "Editor Stop was not confirmed. Nothing was restarted.",
    );
    if (!signal.aborted && isScopeStillActive()) {
      setEditorPhase(finishEditorRestarting);
      onRestartConfirmed();
    }
  } catch (cause) {
    if (!cancel.signal.aborted)
      setEditorPhase((prev) =>
        markEditorRestartFailed(
          prev,
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Editor restart could not be confirmed.",
        ),
      );
  } finally {
    if (session.clearIfCurrent("editorRecovery", cancel)) setEditorPhase(finishEditorRestarting);
  }
}

export async function startWorkspaceSelection(options: {
  allowed: boolean;
  workspaceID: string | undefined;
  starting: boolean;
  start: (() => Promise<void>) | undefined;
  isScopeStillActive: () => boolean;
  setSourcePhase: (updater: (prev: SourcePhase) => SourcePhase) => void;
}) {
  const { allowed, workspaceID, starting, start, isScopeStillActive, setSourcePhase } = options;
  if (!allowed || workspaceID || !start || starting) return;
  setSourcePhase(beginStartingSelection);
  try {
    await start();
  } catch (cause) {
    if (isScopeStillActive())
      setSourcePhase((prev) =>
        markSourceUnavailable(
          prev,
          undefined,
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Workspace Start is unconfirmed. Check its recorded state before retrying.",
        ),
      );
  } finally {
    setSourcePhase(finishStartingSelection);
  }
}

export function syncEditorObservation(options: {
  projectID: string | undefined;
  allowed: boolean;
  retry: number;
  session: DeveloperIDESession;
  timers: WaitTimers;
  ensure: (signal: AbortSignal, projectID: string) => Promise<DeveloperIDEObserved>;
  read: (signal: AbortSignal) => Promise<DeveloperIDEObserved>;
  setEditorPhase: (updater: (prev: EditorPhase) => EditorPhase) => void;
}) {
  const { projectID, allowed, retry, session, timers, ensure, read, setEditorPhase } = options;
  if (session.syncEditorScope(projectID, allowed)) {
    session.abort("editorRecovery");
    session.abort("frameReload");
    setEditorPhase(resetEditorForScopeChange);
  }
  if (!projectID || !allowed) return;
  const cancel = new AbortController();
  setEditorPhase(resumeEditorFromFailure);
  void observeDeveloperIDE({
    signal: cancel.signal,
    admit: session.consumeEditorAdmission(retry),
    timers,
    session,
    ensure: (signal) => ensure(signal, projectID),
    read,
    setEditorPhase,
  });
  return () => cancel.abort();
}

export function syncSourceObservation(options: {
  workspaceID: string | undefined;
  allowed: boolean;
  session: DeveloperIDESession;
  timers: WaitTimers;
  read: (signal: AbortSignal, workspaceID: string) => Promise<WorkspaceSourceView>;
  setSourcePhase: (updater: (prev: SourcePhase) => SourcePhase) => void;
}) {
  const { workspaceID, allowed, session, timers, read, setSourcePhase } = options;
  const scopeChanged = session.syncSourceScope(workspaceID, allowed);
  if (scopeChanged) session.abort("sourceRecovery");
  if (!workspaceID || !allowed) {
    setSourcePhase((prev) => resetSourceToIdle(prev, scopeChanged));
    return;
  }
  setSourcePhase((prev) => beginSourceObservation(prev, workspaceID, scopeChanged));
  const cancel = session.start("sourceObservation");
  void observeWorkspaceSource({
    signal: cancel.signal,
    workspaceID,
    timers,
    read: (signal) => read(signal, workspaceID),
    setSourcePhase,
  });
  return () => session.abortIfCurrent("sourceObservation", cancel);
}
