import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { apiRequest } from "./api-client";
import { developerIDEViewSchema, sourceWorkspaceViewSchema } from "./api-contracts";
import { developmentPreviewMessage, type DevelopmentPreviewMessage } from "./ide-messages";
import { selectedSourcePreparation } from "./selected-source-preparation";
import { recoverWorkspaceSource } from "./source-recovery";
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
  const [editorRetry, setEditorRetry] = createSignal(0);
  const [sourceRetry, setSourceRetry] = createSignal(0);
  let sourceRecovery: AbortController | undefined;
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
  });
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
    if (!workspaceID || !props.allowed || sourceRecovering()) return;
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
  let frame: HTMLIFrameElement | undefined;
  const editorOrigin = () => {
    const current = attachment();
    if (!current) return undefined;
    const url = new URL(window.location.origin);
    url.hostname = `${props.userID.replaceAll("-", "")}.${current.epoch}.editor.runtime.localhost`;
    return url.origin;
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
              <p>{editorError() || "Preparing your editor…"}</p>
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
              <Show when={!ready() || editorError()}>
                <div class="runtime-frame-state empty-workspace" role="status">
                  <p>{editorError() || "Opening your editor…"}</p>
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
        <Show when={editorError() || sourceError()}>
          <div class="editor-recovery">
            <Show when={sourceError()}>
              <p role="status">{sourceError()}</p>
            </Show>
            <div class="editor-recovery-actions">
              <Show when={sourceError()}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={sourceRecovering()}
                  title="Checks the recorded file-access attempt without stopping it."
                  onClick={() => void retrySource(false)}
                >
                  {sourceRecovering() ? "Recovering file access…" : "Retry file access"}
                </button>
                <Show when={sourceState() === "failed" || sourceState() === "stop-intended"}>
                  <button
                    class="quiet-button"
                    type="button"
                    disabled={sourceRecovering()}
                    title="Stops and reopens file access. Keeps your files, running Apps and editor buffers."
                    onClick={() => void retrySource(true)}
                  >
                    Restart file access
                  </button>
                </Show>
              </Show>
              <Show when={editorError()}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={sourceRecovering()}
                  onClick={() => {
                    if (!ready() && frame && attachment())
                      frame.src = attachment()?.url ?? frame.src;
                    setEditorRetry((value) => value + 1);
                  }}
                >
                  Retry editor connection
                </button>
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
