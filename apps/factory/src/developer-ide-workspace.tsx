import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { apiRequest } from "./api-client";
import { developerIDEViewSchema, sourceWorkspaceViewSchema } from "./api-contracts";
import { developmentPreviewMessage, type DevelopmentPreviewMessage } from "./ide-messages";
import { selectedSourcePreparation } from "./selected-source-preparation";
import { recoverWorkspaceSource } from "./source-recovery";
import { confirmAccessStopped } from "./access-stop";
import { developerIDEOrigin } from "./developer-ide-origin";
import type { WorkspaceSourceState } from "../../../packages/workspace-domain/src/source";
import { z } from "zod";

export function DeveloperIDEWorkspace(props: {
  userID: string;
  projectID: string | undefined;
  allowed: boolean;
  preparingSelection?: boolean;
  workspaceID: string | undefined;
  active: boolean;
  onDevelopmentPreview: (message: DevelopmentPreviewMessage) => void;
}) {
  const [attachment, setAttachment] = createSignal<{ epoch: number; url: string }>();
  const [ready, setReady] = createSignal(false);
  const [selected, setSelected] = createSignal<string>();
  const [availableSource, setAvailableSource] = createSignal<string>();
  const [editorError, setEditorError] = createSignal("");
  const [sourceError, setSourceError] = createSignal("");
  const [sourceState, setSourceState] = createSignal<WorkspaceSourceState>();
  const [sourceRecovering, setSourceRecovering] = createSignal(false);
  const [editorRecovering, setEditorRecovering] = createSignal(false);
  const [editorState, setEditorState] = createSignal<WorkspaceSourceState>();
  const [editorRetry, setEditorRetry] = createSignal(0);
  const [sourceRetry, setSourceRetry] = createSignal(0);
  let sourceRecovery: AbortController | undefined;
  let editorRecovery: AbortController | undefined;
  const preparation = selectedSourcePreparation(async (projectID) => {
    await apiRequest(
      sourceWorkspaceViewSchema,
      `/api/projects/${projectID}/source-workspace/ensure`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      },
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
    },
  );
  async function retrySource(restart: boolean) {
    const workspaceID = props.workspaceID;
    if (!workspaceID || !props.allowed || sourceRecovering() || editorRecovering()) return;
    const cancel = new AbortController();
    sourceRecovery = cancel;
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(150_000)]);
    setSourceRecovering(true);
    setAvailableSource(undefined);
    try {
      await recoverWorkspaceSource(workspaceID, restart, signal, {
        stop: (id, signal) =>
          apiRequest(z.undefined(), `/api/workspaces/${id}/source/stop`, {
            method: "POST",
            signal,
          }),
        read: (id, signal) =>
          apiRequest(sourceWorkspaceViewSchema, `/api/workspaces/${id}/source`, { signal }),
        ensure: (id, signal) =>
          apiRequest(sourceWorkspaceViewSchema, `/api/workspaces/${id}/source/ensure`, {
            method: "POST",
            signal,
          }),
        wait: pause,
      });
      if (!cancel.signal.aborted) setSourceRetry((value) => value + 1);
    } catch (cause) {
      if (!cancel.signal.aborted) {
        setSourceState(undefined);
        setSourceError(
          signal.aborted
            ? "File access recovery is taking longer than expected. Your files are retained; retry to check its recorded state."
            : cause instanceof Error
              ? cause.message
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
          stop: (signal) =>
            apiRequest(z.undefined(), "/api/developer-ide/stop", { method: "POST", signal }),
          read: (signal) => apiRequest(developerIDEViewSchema, "/api/developer-ide", { signal }),
          wait: pause,
        },
        "Editor Stop was not confirmed. Nothing was restarted.",
      );
      if (!signal.aborted && props.projectID === projectID && props.allowed)
        setEditorRetry((value) => value + 1);
    } catch (cause) {
      if (!cancel.signal.aborted)
        setEditorError(
          cause instanceof Error ? cause.message : "Editor restart could not be confirmed.",
        );
    } finally {
      if (editorRecovery === cancel) {
        editorRecovery = undefined;
        setEditorRecovering(false);
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
      if (!epoch || editorReady) return;
      const timer = setTimeout(
        () => setEditorError("The editor did not connect. Retry opening it."),
        30_000,
      );
      return () => clearTimeout(timer);
    },
  );
  createEffect(
    () => [props.projectID, props.allowed, editorRetry()] as const,
    ([projectID, allowed]) => {
      if (!projectID || !allowed) return;
      const cancel = new AbortController();
      setEditorError("");
      void (async () => {
        let current = await apiRequest(
          developerIDEViewSchema,
          `/api/projects/${projectID}/developer-ide/ensure`,
          {
            method: "POST",
            signal: cancel.signal,
          },
        );
        const deadline = performance.now() + 150_000;
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
          if (performance.now() >= deadline)
            throw new Error("Editor preparation is taking longer than expected. Retry opening it.");
          await pause(cancel.signal);
          current = await apiRequest(developerIDEViewSchema, "/api/developer-ide", {
            signal: cancel.signal,
          });
        }
      })().catch((cause: unknown) => {
        if (!cancel.signal.aborted)
          setEditorError(cause instanceof Error ? cause.message : "Editor is unavailable.");
      });
      return () => cancel.abort();
    },
  );
  createEffect(
    () => [props.workspaceID, props.allowed, sourceRetry()] as const,
    ([workspaceID, allowed]) => {
      setAvailableSource(undefined);
      setSourceState(undefined);
      if (!workspaceID || !allowed) return;
      const cancel = new AbortController();
      setSourceError("");
      void (async () => {
        const deadline = performance.now() + 150_000;
        while (!cancel.signal.aborted) {
          const source = await apiRequest(
            sourceWorkspaceViewSchema,
            `/api/workspaces/${workspaceID}/source`,
            { signal: cancel.signal },
          );
          if (!cancel.signal.aborted) setSourceState(source.state);
          if (source.state === "ready") {
            if (!cancel.signal.aborted) setAvailableSource(workspaceID);
            return;
          }
          if (["failed", "stopped", "stop-intended"].includes(source.state))
            throw new Error(
              source.failure ??
                "Workspace files are stopped. Reopen this Workspace to prepare them.",
            );
          if (performance.now() >= deadline)
            throw new Error("Workspace files are still preparing. Reopen this Workspace to retry.");
          await pause(cancel.signal);
        }
      })().catch((cause: unknown) => {
        if (!cancel.signal.aborted)
          setSourceError(
            cause instanceof Error ? cause.message : "Workspace files are unavailable.",
          );
      });
      return () => cancel.abort();
    },
  );
  createEffect(
    () => [props.workspaceID, props.allowed, availableSource(), ready()] as const,
    ([workspaceID, allowed, sourceWorkspaceID, editorReady]) => {
      if (!allowed || !editorReady || !workspaceID || sourceWorkspaceID !== workspaceID) return;
      const origin = editorOrigin();
      if (origin)
        frame?.contentWindow?.postMessage(
          { type: "factory:select-workspace", workspaceID },
          origin,
        );
    },
  );
  createEffect(
    () => true,
    () => {
      const receive = (event: MessageEvent<unknown>) => {
        if (event.source !== frame?.contentWindow || event.origin !== editorOrigin()) return;
        const message = event.data;
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
          setEditorError("");
          setReady(true);
        } else if (
          message.type === "factory:workspace-selected" &&
          "workspaceID" in message &&
          message.workspaceID === props.workspaceID
        )
          setSelected(props.workspaceID);
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
                  : editorError() || "Preparing your editor…"}
              </p>
            </div>
          }
        >
          {(current) => (
            <div
              class="runtime-frame"
              inert={ready() && selected() !== props.workspaceID}
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
                onError={() => setEditorError("Could not connect to the editor. Retry opening it.")}
              />
              <Show when={!ready() || editorError() || editorRecovering()}>
                <div class="runtime-frame-state empty-workspace" role="status">
                  <p>
                    {editorRecovering()
                      ? "Restarting your editor…"
                      : editorError() || "Opening your editor…"}
                  </p>
                </div>
              </Show>
            </div>
          )}
        </Show>
        <Show
          when={
            !sourceError() && ready() && (!props.workspaceID || selected() !== props.workspaceID)
          }
        >
          <div class="editor-source-status" role="status">
            Preparing Workspace files…
          </div>
        </Show>
        <Show when={editorError() || sourceError() || editorRecovering()}>
          <div class="editor-recovery">
            <Show when={sourceError()}>
              <p role="status">{sourceError()}</p>
            </Show>
            <div class="editor-recovery-actions">
              <Show when={sourceError()}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={sourceRecovering() || editorRecovering()}
                  title="Checks the recorded file-access attempt without stopping it."
                  onClick={() => void retrySource(false)}
                >
                  {sourceRecovering() ? "Recovering file access…" : "Retry file access"}
                </button>
                <Show when={sourceState() === "failed" || sourceState() === "stop-intended"}>
                  <button
                    class="quiet-button"
                    type="button"
                    disabled={sourceRecovering() || editorRecovering()}
                    title="Stops and reopens file access. Keeps your files, running Apps and editor buffers."
                    onClick={() => void retrySource(true)}
                  >
                    Restart file access
                  </button>
                </Show>
              </Show>
              <Show when={editorError() || editorRecovering()}>
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
