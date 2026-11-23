import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { WorkspaceSourceState } from "../../../packages/workspace-domain/src/source";
import { confirmAccessStopped } from "./access-stop";
import { isUnreachable, plainErrorMessage } from "./command-error";
import { developerIDEOrigin } from "./developer-ide-origin";
import type { ActivityNavigationRequest } from "./ide-messages";
import { type DevelopmentPreviewMessage, developmentPreviewMessage } from "./ide-messages";
import { selectedSourcePreparation } from "./selected-source-preparation";
import { serverCall } from "./server-functions/result";
import {
  ensureDeveloperIDE,
  ensurePersonalSource,
  ensureWorkspaceSource,
  getDeveloperIDE,
  getWorkspaceSource,
  stopDeveloperIDE,
} from "./server-functions/workspaces";
import { createWaitElapsed, waitLabel } from "./wait-elapsed";
import type { WorkspaceSourceView } from "./workspace/contracts";

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
  const [attachment, setAttachment] = createSignal<{ epoch: number; url: string }>();
  const [ready, setReady] = createSignal(false);
  const [selected, setSelected] = createSignal<string>();
  let sentNavigation: string | undefined;
  const [availableSource, setAvailableSource] = createSignal<string>();
  const [editorError, setEditorError] = createSignal("");
  const [editorSlow, setEditorSlow] = createSignal(false);
  const [sourceError, setSourceError] = createSignal("");
  const fileError = () =>
    availableSource() === props.workspaceID && props.workspaceID
      ? ""
      : sourceAccessMessage(sourceError() || props.preparationFailure || "");
  const [sourceState, setSourceState] = createSignal<WorkspaceSourceState>();
  const [sourceRecovering, setSourceRecovering] = createSignal(false);
  const [sourceChecks, setSourceChecks] = createSignal(0);
  const [sourceCheckMessage, setSourceCheckMessage] = createSignal("");
  const [startingSelection, setStartingSelection] = createSignal(false);
  const [editorRecovering, setEditorRecovering] = createSignal(false);
  const [editorState, setEditorState] = createSignal<WorkspaceSourceState>();
  const preparingFiles = () =>
    !fileError() && ready() && (!props.workspaceID || selected() !== props.workspaceID);
  const filesWaited = createWaitElapsed(() =>
    preparingFiles() ? `${props.workspaceID ?? "selection"}:${sourceState() ?? ""}` : undefined,
  );
  const [reconnecting, setReconnecting] = createSignal(false);
  const [editorRetry, setEditorRetry] = createSignal(0);
  let admittedEditorRetry: number | undefined;
  const [sourceRetry, setSourceRetry] = createSignal(0);
  let sourceRecovery: AbortController | undefined;
  let sourceObservation: AbortController | undefined;
  let editorRecovery: AbortController | undefined;
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
  onCleanup(() => {
    preparation.close();
    sourceRecovery?.abort();
    sourceObservation?.abort();
    editorRecovery?.abort();
  });
  createEffect(
    () => [props.projectID, props.allowed] as const,
    () => {
      editorRecovery?.abort();
      editorRecovery = undefined;
      setEditorRecovering(false);
      setEditorState(undefined);
    },
  );
  createEffect(
    () => [props.workspaceID, props.allowed] as const,
    () => {
      sourceRecovery?.abort();
      sourceRecovery = undefined;
      setSourceRecovering(false);
      setSourceChecks(0);
      setSourceCheckMessage("");
    },
  );
  async function retrySource() {
    const workspaceID = props.workspaceID;
    if (!workspaceID) {
      props.onRetrySelection?.();
      return;
    }
    if (!props.allowed || sourceRecovering() || editorRecovering()) return;
    const cancel = new AbortController();
    sourceRecovery = cancel;
    sourceObservation?.abort();
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(150_000)]);
    const check = sourceChecks() + 1;
    setSourceChecks(check);
    setSourceCheckMessage(`File access check ${check}: checking the current Source…`);
    setSourceRecovering(true);
    setAvailableSource(undefined);
    try {
      const source = await serverCall(
        ensureWorkspaceSource({ ...{ signal }, data: [workspaceID] }),
      );
      signal.throwIfAborted();
      if (props.workspaceID !== workspaceID || !props.allowed) return;
      if (source.workspaceID !== workspaceID)
        throw new Error(
          "The file access check returned a different Workspace. Nothing was selected.",
        );
      setSourceState(source.state);
      setSourceError(plainErrorMessage(source.failure ?? ""));
      if (source.state === "ready" && !source.failure) {
        setAvailableSource(workspaceID);
        setSourceCheckMessage("");
      } else {
        setSourceCheckMessage(
          `File access check ${check}: still unavailable. No work was restarted.`,
        );
        if (!source.failure && ["failed", "stopped", "stop-intended"].includes(source.state))
          setSourceError("Workspace file access is stopped or failed. Keep your editor buffer.");
        if (!source.failure && !["failed", "stopped", "stop-intended"].includes(source.state))
          setSourceRetry((value) => value + 1);
      }
    } catch (cause) {
      if (!cancel.signal.aborted) {
        setSourceState(undefined);
        setSourceCheckMessage(
          `File access check ${check}: not confirmed. Keep your unsaved edits.`,
        );
        setSourceError(
          signal.aborted
            ? "The file access check timed out. Keep your editor buffer; retry only checks the current Source."
            : cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "File access could not recover.",
        );
      }
    } finally {
      if (sourceRecovery === cancel) {
        sourceRecovery = undefined;
        setSourceRecovering(false);
      }
    }
  }
  async function startSelection() {
    const start = props.onStartSelection;
    const projectID = props.projectID;
    if (!props.allowed || props.workspaceID || !start || startingSelection()) return;
    setStartingSelection(true);
    try {
      await start();
    } catch (cause) {
      if (props.projectID === projectID && props.onStartSelection === start && !props.workspaceID)
        setSourceError(
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Workspace Start is unconfirmed. Check its recorded state before retrying.",
        );
    } finally {
      setStartingSelection(false);
    }
  }
  async function restartEditor() {
    const projectID = props.projectID;
    if (!projectID || !props.allowed || editorRecovering() || sourceRecovering()) return;
    if (
      !window.confirm(
        "Restart your editor? Unsaved editor changes may be lost. Running Apps and Builds will continue.",
      )
    )
      return;
    const cancel = new AbortController();
    editorRecovery = cancel;
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(150_000)]);
    setEditorRecovering(true);
    setEditorError("");
    try {
      await confirmAccessStopped(
        signal,
        {
          stop: (signal) => serverCall(stopDeveloperIDE({ ...{ signal }, data: [] })),
          read: (signal) => serverCall(getDeveloperIDE({ ...{ signal }, data: [] })),
          wait: pause,
        },
        "Editor Stop was not confirmed. Nothing was restarted.",
      );
      if (!signal.aborted && props.projectID === projectID && props.allowed)
        setEditorRetry((value) => value + 1);
    } catch (cause) {
      if (!cancel.signal.aborted)
        setEditorError(
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Editor restart could not be confirmed.",
        );
    } finally {
      if (editorRecovery === cancel) {
        editorRecovery = undefined;
        setEditorRecovering(false);
      }
    }
  }
  // A brief network loss or server restart heals itself. The user sees a quiet "Reconnecting"
  // note, and the error with its buttons appears only when the outage outlasts a minute.
  async function tolerant<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    const started = performance.now();
    for (;;) {
      try {
        const value = await call();
        setReconnecting(false);
        return value;
      } catch (cause) {
        if (!isUnreachable(cause) || signal.aborted || performance.now() - started > 60_000) {
          setReconnecting(false);
          throw cause;
        }
        setReconnecting(true);
        await outagePause(signal);
      }
    }
  }
  let frame: HTMLIFrameElement | undefined;
  const editorOrigin = () => {
    const current = attachment();
    if (!current) return undefined;
    return developerIDEOrigin(window.location.origin, props.userID, current.epoch);
  };
  createEffect(
    () => [attachment()?.epoch, ready(), editorRetry()] as const,
    ([epoch, editorReady]) => {
      setEditorSlow(false);
      if (!epoch || editorReady) return;
      const timer = setTimeout(() => setEditorSlow(true), 30_000);
      return () => clearTimeout(timer);
    },
  );
  createEffect(
    () => [props.projectID, props.allowed, editorRetry()] as const,
    ([projectID, allowed, retry]) => {
      if (!projectID || !allowed) return;
      const cancel = new AbortController();
      setEditorError("");
      // Mount and explicit Retry admit once. Project/access changes and lost
      // acknowledgements only observe; they cannot reuse demand after Stop.
      let admit = admittedEditorRetry !== retry;
      admittedEditorRetry = retry;
      void (async () => {
        let current = await tolerant(cancel.signal, () => {
          if (!admit)
            return serverCall(getDeveloperIDE({ ...{ signal: cancel.signal }, data: [] }));
          admit = false;
          return serverCall(
            ensureDeveloperIDE({ ...{ signal: cancel.signal }, data: [projectID] }),
          );
        });
        while (!cancel.signal.aborted) {
          setEditorState(current.state);
          if (current.state === "ready") {
            if (attachment()?.epoch !== current.epoch) {
              setReady(false);
              setSelected(undefined);
              setAttachment({
                epoch: current.epoch,
                url: `/api/developer-ide/access?embed=1&epoch=${current.epoch}`,
              });
            }
            return;
          }
          if (["failed", "stopped", "stop-intended"].includes(current.state))
            throw new Error(current.failure ?? "Editor is stopped. Retry to prepare it.");
          await pause(cancel.signal);
          current = await tolerant(cancel.signal, () =>
            serverCall(getDeveloperIDE({ ...{ signal: cancel.signal }, data: [] })),
          );
        }
      })().catch((cause: unknown) => {
        if (!cancel.signal.aborted)
          setEditorError(
            cause instanceof Error ? plainErrorMessage(cause.message) : "Editor is unavailable.",
          );
      });
      return () => cancel.abort();
    },
  );
  createEffect(
    () => [props.workspaceID, props.allowed, sourceRetry()] as const,
    ([workspaceID, allowed]) => {
      setAvailableSource(undefined);
      setSourceState(undefined);
      setSourceError("");
      if (!workspaceID || !allowed) return;
      const cancel = new AbortController();
      sourceObservation = cancel;
      void (async () => {
        while (!cancel.signal.aborted) {
          const source: WorkspaceSourceView = await tolerant(cancel.signal, () =>
            serverCall(getWorkspaceSource({ ...{ signal: cancel.signal }, data: [workspaceID] })),
          );
          if (!cancel.signal.aborted) {
            setSourceState(source.state);
            setSourceError(plainErrorMessage(source.failure ?? ""));
          }
          if (source.workspaceID !== workspaceID)
            throw new Error("File access returned a different Workspace. Nothing was selected.");
          if (source.state === "ready" && !source.failure) {
            if (!cancel.signal.aborted) {
              setAvailableSource(workspaceID);
              setSourceCheckMessage("");
            }
            return;
          }
          if (["failed", "stopped", "stop-intended"].includes(source.state))
            throw new Error(
              source.failure ??
                "Workspace files are stopped. Reopen this Workspace to prepare them.",
            );
          // An unavailable owner needs an explicit check, not repeated polling
          // presented as preparation or a silent attempt to change its writer.
          if (source.failure) return;
          await pause(cancel.signal);
        }
      })().catch((cause: unknown) => {
        if (!cancel.signal.aborted)
          setSourceError(
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "Workspace files are unavailable.",
          );
      });
      return () => {
        cancel.abort();
        if (sourceObservation === cancel) sourceObservation = undefined;
      };
    },
  );
  createEffect(
    () =>
      [
        props.workspaceID,
        props.allowed,
        availableSource(),
        ready(),
        props.active,
        editorOrigin(),
      ] as const,
    ([workspaceID, allowed, sourceWorkspaceID, editorReady, active, origin]) => {
      if (!active || !allowed || !editorReady || !workspaceID || sourceWorkspaceID !== workspaceID)
        return;
      if (origin)
        frame?.contentWindow?.postMessage(
          { type: "factory:select-workspace", workspaceID },
          origin,
        );
    },
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
    ([target, workspaceID, allowed, active, selectedID, editorReady, origin]) => {
      if (
        !target ||
        !allowed ||
        !active ||
        !editorReady ||
        target.workspaceID !== workspaceID ||
        selectedID !== workspaceID ||
        sentNavigation === target.id
      )
        return;
      if (!origin || !frame?.contentWindow) return;
      sentNavigation = target.id;
      frame.contentWindow.postMessage({ ...target, type: "factory:open-activity" }, origin);
    },
  );
  createEffect(
    () => true,
    () => {
      const receive = (event: MessageEvent<unknown>) => {
        if (event.source !== frame?.contentWindow || event.origin !== editorOrigin()) return;
        const message = event.data;
        const navigation = props.navigation;
        if (!message || typeof message !== "object" || !("type" in message)) return;
        const preview = developmentPreviewMessage(message);
        if (
          preview &&
          preview.workspaceID === props.workspaceID &&
          preview.workspaceID === selected()
        ) {
          props.onDevelopmentPreview(preview);
          return;
        }
        if (message.type === "factory:ide-ready") {
          sentNavigation = undefined;
          setEditorError("");
          setReady(true);
        } else if (
          message.type === "factory:workspace-selected" &&
          "workspaceID" in message &&
          message.workspaceID === props.workspaceID
        )
          setSelected(props.workspaceID);
        else if (
          message.type === "factory:activity-opened" &&
          "id" in message &&
          "workspaceID" in message &&
          navigation &&
          message.id === navigation.id &&
          message.workspaceID === navigation.workspaceID
        )
          props.onNavigationOutcome?.(
            navigation.id,
            "error" in message && typeof message.error === "string"
              ? message.error.slice(0, 500)
              : undefined,
          );
      };
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    },
  );
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
              <p>
                {editorRecovering()
                  ? "Restarting your editor…"
                  : editorError() || (reconnecting() ? "Reconnecting…" : "Preparing your editor…")}
              </p>
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
                  const document = event.currentTarget.contentDocument;
                  if (document?.contentType === "application/json")
                    setEditorError("Editor access was rejected. Retry opening it.");
                }}
                onError={() => {
                  // The frame reloads itself once the connection is back.
                  setReconnecting(true);
                  void outagePause(new AbortController().signal).then(() => {
                    setReconnecting(false);
                    if (!ready() && frame && attachment())
                      frame.src = attachment()?.url ?? frame.src;
                  });
                }}
              />
              <Show when={!ready() || editorError() || editorRecovering()}>
                <div class="runtime-frame-state empty-workspace" role="status">
                  <p>
                    {editorRecovering()
                      ? "Restarting your editor…"
                      : editorError() ||
                        (reconnecting()
                          ? "Reconnecting…"
                          : editorSlow()
                            ? "Your editor is still opening. You can wait or retry the connection."
                            : "Opening your editor…")}
                  </p>
                </div>
              </Show>
            </div>
          )}
        </Show>
        <Show when={preparingFiles()}>
          <div class="editor-source-status" role="status">
            Preparing Workspace files…
            <Show when={filesWaited() >= 5_000}>
              <small aria-live="off">
                {" "}
                {sourceState() === "ready"
                  ? "Files are ready. Selecting them in the editor"
                  : sourceState() === "preparing" || sourceState() === "create-intended"
                    ? "File access is still preparing"
                    : "Checking file access"}
                , {waitLabel(filesWaited())} in this step.
              </small>
            </Show>
          </div>
        </Show>
        <Show
          when={
            editorError() ||
            editorSlow() ||
            fileError() ||
            editorRecovering() ||
            sourceCheckMessage()
          }
        >
          <div class="editor-recovery">
            <Show when={fileError()}>
              <p role="status">{fileError()}</p>
            </Show>
            <Show when={sourceCheckMessage()}>
              <p role="status" aria-label="File access check">
                {sourceCheckMessage()}
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
              <Show when={editorError() || editorSlow() || editorRecovering()}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={sourceRecovering() || editorRecovering()}
                  onClick={() => {
                    if (!ready() && frame && attachment())
                      frame.src = attachment()?.url ?? frame.src;
                    setEditorRetry((value) => value + 1);
                  }}
                >
                  Retry editor connection
                </button>
                <Show when={["failed", "stopped", "stop-intended"].includes(editorState() ?? "")}>
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

function sourceAccessMessage(message: string) {
  const plain = plainErrorMessage(message);
  return plain ===
    "The current Source owner is frozen or unavailable. Compute was not started; keep your editor buffer."
    ? "File access is not ready. The Workspace may still be starting or reconnecting. Keep your unsaved edits."
    : plain;
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 200);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

// Waits for the browser to report a connection again, or two seconds, whichever comes first.
function outagePause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("online", finish);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      window.removeEventListener("online", finish);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, 2000);
    window.addEventListener("online", finish, { once: true });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
