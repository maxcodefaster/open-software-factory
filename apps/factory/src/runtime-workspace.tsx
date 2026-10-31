import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { workspacePresence } from "../../../packages/interface-domain/src/workspace-presence";
import type { AppPreview, RuntimeAttempt } from "./api-contracts";
import { PreviewReview } from "./review/preview";
import { appRuntimeOrigin } from "./runtime-origins";
import {
  retryableMainPreview,
  runtimeReconnecting,
  runtimeWorkspaceURL,
} from "./runtime-workspace-state";
import type { WorkspaceTab } from "./workspace-tabs";

export function RuntimeWorkspaceTabs(props: {
  projectID: string;
  tabs: readonly WorkspaceTab[];
  activeTabID: string | undefined;
  attempts: readonly RuntimeAttempt[];
  previews: readonly AppPreview[];
  pending: boolean;
  userID: string;
  canDevelop: boolean;
  onOpenTicket?(changeID: string): void;
  onRetryMainPreview?: ((tab: WorkspaceTab) => Promise<void>) | undefined;
}) {
  const runtimeTabs = () => props.tabs.filter((tab) => tab.view === "preview");
  return (
    <For
      each={runtimeTabs()}
      keyed={(tab) => `${props.projectID}:${tab.id}:${tab.attemptID ?? "pending"}`}
    >
      {(tab) => {
        const active = () => props.activeTabID === tab().id;
        const attempt = () =>
          props.attempts.find(
            (candidate) =>
              candidate.id === tab().attemptID && candidate.projectId === props.projectID,
          );
        const url = createMemo<string | undefined>((attachedURL) =>
          runtimeWorkspaceURL(
            tab(),
            props.projectID,
            props.attempts,
            attachedURL,
            props.previews,
            active(),
          ),
        );
        const reconnecting = () => runtimeReconnecting(attempt());
        const review = createMemo(() => {
          const changeID = attempt()?.changeId;
          if (!changeID) return undefined;
          return {
            projectID: props.projectID,
            changeID,
            userID: props.userID,
            canDevelop: props.canDevelop,
            onOpenTicket: props.onOpenTicket ? () => props.onOpenTicket?.(changeID) : undefined,
          };
        });
        const status = () => {
          if (reconnecting()) return "Connection interrupted. Reconnecting to the same Workspace…";
          const current = attempt();
          if (current?.state === "cleanup-failed")
            return "Preview cleanup is unconfirmed. A new Start is blocked.";
          if (current?.runtimeKind === "staging" && current.state === "failed")
            return "Main Preview failed to start.";
          if (current?.computeWait)
            return "Waiting for execution capacity. The Preview starts automatically when space is available.";
          if (current) return workspacePresence({ runtimeState: current.state });
          if (props.pending) return "Opening the Workspace…";
          return tab().view === "ide"
            ? "The Workspace is not running. Open IDE to retry."
            : "The Preview is not running. Open Preview to retry.";
        };
        return (
          <div class="runtime-workspace-tab" hidden={!active()} inert={!active()}>
            <RuntimeWorkspace
              title={tab().view === "ide" ? "IDE" : "Preview"}
              attemptID={tab().attemptID}
              appChannel={tab().appChannel}
              url={url()}
              reconnecting={reconnecting()}
              loadingLabel={status()}
              failure={
                reconnecting() ? undefined : (attempt()?.failure ?? tab().preparationFailure)
              }
              onRetry={
                props.onRetryMainPreview && retryableMainPreview(attempt(), props.projectID)
                  ? () => props.onRetryMainPreview?.(tab()) ?? Promise.resolve()
                  : undefined
              }
              active={active()}
              review={review()}
            />
          </div>
        );
      }}
    </For>
  );
}

export function RuntimeWorkspace(props: {
  title: "IDE" | "Preview";
  attemptID?: string | undefined;
  appChannel?: string | undefined;
  url?: string | undefined;
  loadingLabel: string;
  failure?: string | null | undefined;
  onRetry?: (() => Promise<void>) | undefined;
  reconnecting?: boolean;
  active?: boolean | undefined;
  review?:
    | {
        projectID?: string | undefined;
        changeID: string;
        userID: string;
        canDevelop: boolean;
        onOpenTicket?: (() => void) | undefined;
      }
    | undefined;
}) {
  const [retrying, setRetrying] = createSignal(false);
  const [retryError, setRetryError] = createSignal("");
  async function retry() {
    if (retrying() || !props.onRetry) return;
    setRetrying(true);
    setRetryError("");
    try {
      await props.onRetry();
    } catch (cause) {
      setRetryError(
        cause instanceof Error ? cause.message : "The Main Preview start could not be confirmed.",
      );
    } finally {
      setRetrying(false);
    }
  }
  return (
    <div class="runtime-workspace">
      <Show
        when={props.url}
        fallback={
          <div class="empty-workspace runtime-start-state" role="status">
            <p>{props.loadingLabel}</p>
            <Show when={props.failure}>{(failure) => <p role="note">{failure()}</p>}</Show>
            <Show when={props.onRetry}>
              <button
                type="button"
                class="primary-button"
                disabled={retrying()}
                onClick={() => void retry()}
              >
                {retrying() ? "Starting Main Preview…" : "Retry Main Preview"}
              </button>
            </Show>
            <Show when={retryError()}>{(error) => <p role="alert">{error()}</p>}</Show>
          </div>
        }
      >
        {(url) => (
          <AttachedRuntimeFrame
            title={props.title}
            attemptID={props.attemptID}
            appChannel={props.appChannel}
            url={url()}
            reconnecting={Boolean(props.reconnecting)}
            review={props.review}
            active={props.active}
          />
        )}
      </Show>
    </div>
  );
}

function AttachedRuntimeFrame(props: {
  title: "IDE" | "Preview";
  attemptID: string | undefined;
  appChannel?: string | undefined;
  url: string;
  reconnecting?: boolean;
  active?: boolean | undefined;
  review?:
    | {
        projectID?: string | undefined;
        changeID: string;
        userID: string;
        canDevelop: boolean;
        onOpenTicket?: (() => void) | undefined;
      }
    | undefined;
}) {
  const [phase, setPhase] = createSignal<"loading" | "loaded" | "failed">("loading");
  const [documentFailed, setDocumentFailed] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  const activePreviewID = () =>
    props.title === "Preview" && props.active !== false ? props.attemptID : undefined;
  function usePreview(attemptID: string | undefined) {
    if (!attemptID) return;
    frame?.contentWindow?.postMessage(
      { type: "factory-runtime-use" },
      appRuntimeOrigin(location.origin, attemptID, props.appChannel ?? "app"),
    );
  }
  createEffect(activePreviewID, usePreview);
  createEffect(
    () => props.url,
    () => {
      setDocumentFailed(false);
      setPhase("loading");
    },
  );
  createEffect(phase, (current) => {
    if (current !== "loading") return;
    // iframe errors do not cover a response that never completes. Keep the same
    // attachment and offer a local reload instead of preparing another runtime.
    const timer = setTimeout(() => setPhase("failed"), 30_000);
    return () => clearTimeout(timer);
  });
  createEffect(
    () => ({
      preview: props.title === "Preview",
      attemptID: props.attemptID,
      appChannel: props.appChannel,
    }),
    (current) => {
      if (!current.preview || !current.attemptID) return;
      const origin = appRuntimeOrigin(
        location.origin,
        current.attemptID,
        current.appChannel ?? "app",
      );
      const ready = (event: MessageEvent) => {
        if (
          event.origin !== origin ||
          event.source !== frame?.contentWindow ||
          !event.data ||
          typeof event.data !== "object" ||
          !["factory-preview-document-ready", "factory-preview-document-failed"].includes(
            event.data.type,
          )
        )
          return;
        if (event.data.type === "factory-preview-document-failed") {
          setDocumentFailed(true);
          setPhase("failed");
          return;
        }
        // The document is attached even if a nonessential image is still loading.
        // This is not App health, runtime readiness or review evidence.
        setDocumentFailed(false);
        setPhase("loaded");
        usePreview(activePreviewID());
      };
      window.addEventListener("message", ready);
      return () => window.removeEventListener("message", ready);
    },
  );

  function reload() {
    if (!frame) return;
    setDocumentFailed(false);
    setPhase("loading");
    frame.src = props.url;
  }

  return (
    <div
      class="runtime-frame"
      aria-busy={phase() === "loading" || props.reconnecting ? "true" : "false"}
    >
      <iframe
        ref={frame}
        title={`Factory ${props.title}`}
        data-runtime-attempt-id={props.attemptID}
        src={props.url}
        inert={phase() !== "loaded" || props.reconnecting}
        aria-hidden={phase() !== "loaded" || props.reconnecting ? "true" : undefined}
        onLoad={(event) => {
          // The initial same-origin blank document is not an attachment. A routed document
          // may be cross-origin; contentDocument is null there. Load proves document delivery,
          // not application health or readiness of an App's JavaScript.
          const document = event.currentTarget.contentDocument;
          if (document?.URL === "about:blank") return;
          // Access rejection returns Factory JSON rather than redirecting to the runtime.
          // Browsers still fire load for that HTTP error. Do not expose it as an attached IDE.
          const accessRejected =
            document?.contentType === "application/json" &&
            new URL(document.URL).pathname === "/api/runtime-access";
          const rejected = accessRejected || documentFailed();
          setPhase(rejected ? "failed" : "loaded");
          if (!rejected) usePreview(activePreviewID());
        }}
        onError={() => setPhase("failed")}
      />
      <Show
        when={
          props.title === "Preview" && props.review && props.attemptID && phase() === "loaded"
            ? { review: props.review, attemptID: props.attemptID }
            : undefined
        }
      >
        {(context) => (
          <PreviewReview
            projectID={context().review.projectID}
            changeID={context().review.changeID}
            attemptID={context().attemptID}
            userID={context().review.userID}
            canDevelop={context().review.canDevelop}
            active={props.active !== false}
            onOpenTicket={context().review.onOpenTicket}
            frame={() => frame}
            runtimeOrigin={appRuntimeOrigin(
              location.origin,
              context().attemptID,
              props.appChannel ?? "app",
            )}
          />
        )}
      </Show>
      <Show when={phase() !== "loaded" || props.reconnecting}>
        <div
          class="runtime-frame-state empty-workspace"
          role="status"
          aria-label={`${props.title} connection`}
        >
          <Show
            when={phase() === "failed" && !props.reconnecting}
            fallback={
              <p>
                {props.reconnecting
                  ? "Connection interrupted. Reconnecting to the same Workspace…"
                  : props.title === "IDE"
                    ? "Workspace is running. Opening IDE…"
                    : "Opening Preview…"}
              </p>
            }
          >
            <p>Could not open {props.title}. Reload this view to retry.</p>
            <button type="button" class="primary-button" onClick={reload}>
              Reload view
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
