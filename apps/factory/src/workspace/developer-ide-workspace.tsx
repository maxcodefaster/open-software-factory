import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  type ActivityNavigationRequest,
  type DevelopmentPreviewMessage,
  developmentPreviewMessage,
} from "../ide-messages";
import { selectedSourcePreparation } from "../selected-source-preparation";
import { serverCall } from "../server-functions/result";
import {
  ensureDeveloperIDE,
  ensurePersonalSource,
  ensureWorkspaceSource,
  getDeveloperIDE,
  getWorkspaceSource,
  stopDeveloperIDE,
} from "../server-functions/workspaces";
import { createWaitElapsed, waitLabel } from "../wait-elapsed";
import { developerIDEOrigin } from "./developer-ide-origin";
import * as ide from "./developer-ide-state";

export function DeveloperIDEWorkspace(props: {
  userID: string;
  projectID: string | undefined;
  allowed: boolean;
  preparingSelection?: boolean;
  workspaceID: string | undefined;
  preparationFailure?: string | undefined;
  onRetrySelection?: (() => void) | undefined;
  onStartSelection?: (() => Promise<void>) | undefined;
  active: boolean;
  onDevelopmentPreview: (message: DevelopmentPreviewMessage) => void;
  navigation?: ActivityNavigationRequest | undefined;
  onNavigationOutcome?: ((id: string, error?: string) => void) | undefined;
}) {
  const [editorPhase, setEditorPhase] = createSignal<ide.EditorPhase>(ide.initialEditorPhase());
  const [sourcePhase, setSourcePhase] = createSignal<ide.SourcePhase>(ide.initialSourcePhase());
  const [editorRetry, setEditorRetry] = createSignal(0);
  const [sourceRetry, setSourceRetry] = createSignal(0);
  const session = ide.createDeveloperIDESession();
  const timers = ide.createWaitTimers({
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (id) => clearTimeout(id),
  });
  let frame: HTMLIFrameElement | undefined;

  const attachment = () => editorPhase().attachment;
  const ready = () => editorPhase().kind === "ready";
  const editorState = () => editorPhase().state;
  const editorError = () => ide.editorErrorMessage(editorPhase());
  const selected = () => ide.editorSelectedWorkspace(editorPhase());
  const availableSource = () => ide.sourceAvailableWorkspace(sourcePhase());
  const sourceState = () => ide.sourceObservedState(sourcePhase());
  const fileError = () =>
    availableSource() === props.workspaceID && props.workspaceID
      ? ""
      : ide.sourceAccessMessage(
          ide.sourceErrorMessage(sourcePhase()) || props.preparationFailure || "",
        );
  const preparingFiles = () =>
    !fileError() && ready() && (!props.workspaceID || selected() !== props.workspaceID);
  const filesWaited = createWaitElapsed(() =>
    preparingFiles() ? `${props.workspaceID ?? "selection"}:${sourceState() ?? ""}` : undefined,
  );
  const editorOrigin = () => {
    const current = attachment();
    return current
      ? developerIDEOrigin(window.location.origin, props.userID, current.epoch)
      : undefined;
  };
  const editorRecovering = () => editorPhase().kind === "restarting";
  const sourceRecovering = () => sourcePhase().kind === "checking";
  const startingSelection = () => sourcePhase().kind === "starting-selection";
  const showEditorActions = () =>
    Boolean(editorError() || ide.editorIsSlow(editorPhase()) || editorRecovering());

  const preparation = selectedSourcePreparation(async (projectID) => {
    await serverCall(
      ensurePersonalSource({ ...{ signal: AbortSignal.timeout(15_000) }, data: [projectID] }),
    );
  });
  createEffect(
    () => [props.projectID, props.allowed, props.preparingSelection] as const,
    ([projectID, allowed, preparingSelection]) =>
      preparation.select(allowed && !preparingSelection ? projectID : undefined),
  );

  const { retrySource, startSelection, restartEditor } = ide.createDeveloperIDEActions({
    session,
    timers,
    props,
    getEditorPhase: editorPhase,
    setEditorPhase,
    getSourcePhase: sourcePhase,
    setSourcePhase,
    ensureSource: (signal, id) => serverCall(ensureWorkspaceSource({ ...{ signal }, data: [id] })),
    stopEditor: (signal) => serverCall(stopDeveloperIDE({ ...{ signal }, data: [] })),
    readEditor: (signal) => serverCall(getDeveloperIDE({ ...{ signal }, data: [] })),
    onRetrySourceObservation: () => setSourceRetry((value) => value + 1),
    onRestartConfirmed: () => setEditorRetry((value) => value + 1),
  });

  createEffect(
    () => {
      const phase = editorPhase();
      return phase.kind === "loading-frame"
        ? `${phase.attachment.epoch}:${editorRetry()}`
        : undefined;
    },
    (loadingKey) => {
      if (!loadingKey) return;
      setEditorPhase((prev) => ide.setEditorSlowPhase(prev, false));
      const timer = setTimeout(
        () => setEditorPhase((prev) => ide.setEditorSlowPhase(prev, true)),
        30_000,
      );
      return () => clearTimeout(timer);
    },
  );

  createEffect(
    () => [props.projectID, props.allowed, editorRetry()] as const,
    ([projectID, allowed, retry]) =>
      ide.syncEditorObservation({
        projectID,
        allowed,
        retry,
        session,
        timers,
        ensure: (signal, id) => serverCall(ensureDeveloperIDE({ ...{ signal }, data: [id] })),
        read: (signal) => serverCall(getDeveloperIDE({ ...{ signal }, data: [] })),
        setEditorPhase,
      }),
  );

  createEffect(
    () => [props.workspaceID, props.allowed, sourceRetry()] as const,
    ([workspaceID, allowed]) =>
      ide.syncSourceObservation({
        workspaceID,
        allowed,
        session,
        timers,
        read: (signal, id) => serverCall(getWorkspaceSource({ ...{ signal }, data: [id] })),
        setSourcePhase,
      }),
  );

  createEffect(
    () =>
      [
        props.workspaceID,
        props.allowed,
        availableSource(),
        selected(),
        ready(),
        props.active,
        editorOrigin(),
      ] as const,
    ([workspaceID, allowed, sourceID, selectedID, editorReady, active, origin]) =>
      ide.postWorkspaceSelection(
        frame,
        origin,
        active,
        allowed,
        editorReady,
        workspaceID,
        sourceID,
        selectedID,
      ),
  );

  createEffect(
    () =>
      [
        props.navigation,
        props.workspaceID,
        props.allowed,
        props.active,
        selected(),
        ready(),
        editorOrigin(),
      ] as const,
    ([target, workspaceID, allowed, active, selectedID, editorReady, origin]) =>
      ide.postActivityNavigation(
        frame,
        origin,
        active,
        allowed,
        editorReady,
        workspaceID,
        selectedID,
        target,
        session,
      ),
  );

  const unbindMessages = ide.bindEditorWindowMessages({
    props,
    frame: () => frame,
    origin: editorOrigin,
    selectedWorkspaceID: selected,
    session,
    parsePreview: (raw) => developmentPreviewMessage(raw),
    onReady: () => setEditorPhase(ide.markEditorReadyMessage),
    onWorkspaceSelected: (id) =>
      setEditorPhase((prev) => ide.markEditorWorkspaceSelected(prev, id)),
  });
  onCleanup(() => {
    unbindMessages();
    preparation.close();
    session.abortAll();
  });

  const reloadFrame = () => {
    const currentAttachment = attachment();
    if (!ready() && frame && currentAttachment) frame.src = currentAttachment.url;
  };

  return (
    <div
      class="runtime-workspace-tab"
      hidden={!props.active}
      inert={!props.active || !props.allowed}
    >
      <div class="runtime-workspace">
        <Show
          when={attachment()}
          fallback={
            <div class="empty-workspace" role="status">
              <p>{ide.editorPlaceholderMessage(editorPhase())}</p>
            </div>
          }
        >
          {(current) => (
            <div
              class="runtime-frame"
              inert={
                ready() &&
                (selected() !== props.workspaceID || availableSource() !== props.workspaceID)
              }
              aria-busy={!ready() || selected() !== props.workspaceID ? "true" : "false"}
            >
              <iframe
                title="Factory IDE"
                ref={frame}
                src={current().url}
                data-editor-epoch={current().epoch}
                data-workspace-id={selected()}
                onLoad={(event) => {
                  if (event.currentTarget.contentDocument?.contentType === "application/json")
                    setEditorPhase((prev) =>
                      ide.markEditorRestartFailed(
                        prev,
                        "Editor access was rejected. Retry opening it.",
                      ),
                    );
                }}
                onError={() =>
                  ide.scheduleFrameReload({
                    session,
                    timers,
                    onReconnecting: (value) =>
                      setEditorPhase((prev) => ide.setEditorFrameReconnecting(prev, value)),
                    reloadFrame,
                  })
                }
              />
              <Show when={!ready() || editorError() || editorRecovering()}>
                <div class="runtime-frame-state empty-workspace" role="status">
                  <p>{ide.editorFrameOverlayMessage(editorPhase())}</p>
                </div>
              </Show>
            </div>
          )}
        </Show>
        <Show when={preparingFiles()}>
          <div class="editor-source-status" role="status">
            Opening Workspace…
            <Show when={filesWaited() >= 5_000}>
              <small aria-live="off">
                {" "}
                {ide.sourceWaitDetailMessage(sourceState())}, {waitLabel(filesWaited())} in this
                step.
              </small>
            </Show>
          </div>
        </Show>
        <Show when={sourceState() === "paused" && availableSource() === props.workspaceID}>
          <div class="editor-source-status editor-paused-status" role="status">
            Files and unsaved edits are kept. Opening current files may resume compute, not Coding.
          </div>
        </Show>
        <Show when={showEditorActions() || fileError() || sourcePhase().checkMessage}>
          <div class="editor-recovery">
            <Show when={fileError()}>
              <p role="status">{fileError()}</p>
            </Show>
            <Show when={sourcePhase().checkMessage}>
              <p role="status" aria-label="File access check">
                {sourcePhase().checkMessage}
              </p>
            </Show>
            <div class="editor-recovery-actions">
              <Show when={fileError() && !props.workspaceID && props.onStartSelection}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={startingSelection() || sourceRecovering() || editorRecovering()}
                  onClick={() => void startSelection()}
                >
                  {startingSelection() ? "Starting compute…" : "Start compute"}
                </button>
              </Show>
              <Show when={fileError()}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={startingSelection() || sourceRecovering() || editorRecovering()}
                  title="Checks the current file owner without stopping Source or starting compute."
                  onClick={() => void retrySource()}
                >
                  {sourceRecovering() ? "Checking file access…" : "Retry file access"}
                </button>
              </Show>
              <Show when={showEditorActions()}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={sourceRecovering() || editorRecovering()}
                  onClick={() => {
                    reloadFrame();
                    setEditorRetry((value) => value + 1);
                  }}
                >
                  Retry editor connection
                </button>
                <Show when={ide.TERMINAL_STATES.has(editorState() ?? "")}>
                  <button
                    class="quiet-button"
                    type="button"
                    disabled={sourceRecovering() || editorRecovering()}
                    title="Stops your editor before starting another epoch. Running Apps and Builds are not restarted."
                    onClick={() => void restartEditor()}
                  >
                    {editorRecovering() ? "Restarting editor…" : "Restart editor"}
                  </button>
                </Show>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
