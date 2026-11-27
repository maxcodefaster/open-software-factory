import type { WorkspaceSourceView } from "./contracts";
import type { EditorPhase } from "./developer-ide-model";
import {
  checkWorkspaceSource,
  type DeveloperIDEObserved,
  restartDeveloperIDE,
  startWorkspaceSelection,
} from "./developer-ide-operations";
import type { DeveloperIDESession, WaitTimers } from "./developer-ide-session";
import type { SourcePhase } from "./developer-ide-source-model";

export function createDeveloperIDEActions(options: {
  session: DeveloperIDESession;
  timers: WaitTimers;
  props: {
    readonly projectID: string | undefined;
    readonly workspaceID: string | undefined;
    readonly allowed: boolean;
    readonly onRetrySelection?: (() => void) | undefined;
    readonly onStartSelection?: (() => Promise<void>) | undefined;
  };
  getEditorPhase: () => EditorPhase;
  setEditorPhase: (updater: (prev: EditorPhase) => EditorPhase) => void;
  getSourcePhase: () => SourcePhase;
  setSourcePhase: (updater: (prev: SourcePhase) => SourcePhase) => void;
  ensureSource: (signal: AbortSignal, workspaceID: string) => Promise<WorkspaceSourceView>;
  stopEditor: (signal: AbortSignal) => Promise<unknown>;
  readEditor: (signal: AbortSignal) => Promise<DeveloperIDEObserved>;
  onRetrySourceObservation: () => void;
  onRestartConfirmed: () => void;
}) {
  async function retrySource() {
    const workspaceID = options.props.workspaceID;
    if (!workspaceID) return options.props.onRetrySelection?.();
    if (
      !options.props.allowed ||
      options.getSourcePhase().kind === "checking" ||
      options.getEditorPhase().kind === "restarting"
    )
      return;
    await checkWorkspaceSource({
      workspaceID,
      session: options.session,
      getSourcePhase: options.getSourcePhase,
      setSourcePhase: options.setSourcePhase,
      isScopeStillActive: () => options.props.workspaceID === workspaceID && options.props.allowed,
      ensure: (signal) => options.ensureSource(signal, workspaceID),
      onRetryObservation: options.onRetrySourceObservation,
    });
  }

  function startSelection() {
    const start = options.props.onStartSelection;
    const projectID = options.props.projectID;
    return startWorkspaceSelection({
      allowed: options.props.allowed,
      workspaceID: options.props.workspaceID,
      starting: options.getSourcePhase().kind === "starting-selection",
      start,
      isScopeStillActive: () =>
        options.props.projectID === projectID &&
        options.props.onStartSelection === start &&
        !options.props.workspaceID,
      setSourcePhase: options.setSourcePhase,
    });
  }

  function restartEditor() {
    const projectID = options.props.projectID;
    return restartDeveloperIDE({
      projectID,
      allowed: options.props.allowed,
      editorRecovering: options.getEditorPhase().kind === "restarting",
      sourceRecovering: options.getSourcePhase().kind === "checking",
      session: options.session,
      timers: options.timers,
      setEditorPhase: options.setEditorPhase,
      isScopeStillActive: () => options.props.projectID === projectID && options.props.allowed,
      stop: options.stopEditor,
      read: options.readEditor,
      onRestartConfirmed: options.onRestartConfirmed,
    });
  }

  return { retrySource, startSelection, restartEditor };
}
