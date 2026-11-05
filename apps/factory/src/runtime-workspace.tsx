import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { workspacePresence } from "../../../packages/interface-domain/src/workspace-presence";
import type { AppPreview, RuntimeAttempt } from "./api-contracts";
import { plainErrorMessage } from "./command-error";
import {
  appResponseNotice,
  boundedCause,
  previewStatus,
  restoreFailedDetail,
  restoreFailedHeadline,
  restoreUnknownDetail,
  restoreUnknownHeadline,
} from "./preview-status";
import { PreviewReview } from "./review/preview";
import { appRuntimeOrigin } from "./runtime-origins";
import {
  retryableMainPreview,
  runtimeReconnecting,
  runtimeWorkspaceURL,
} from "./runtime-workspace-state";
import { createWaitElapsed, waitLabel } from "./wait-elapsed";
import type { WorkspaceTab } from "./workspace-tabs";

const plainFailure = (failure: string | undefined) =>
  failure === undefined ? undefined : plainErrorMessage(failure);

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
  onStartFresh?: ((tab: WorkspaceTab) => Promise<void>) | undefined;
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
        const app = () =>
          props.previews.find(
            (preview) =>
              preview.attemptID === tab().attemptID &&
              preview.projectID === props.projectID &&
              preview.channel === tab().appChannel,
          );
        const reconnecting = () => runtimeReconnecting(attempt());
        const waited = createWaitElapsed(() =>
          !url() && !reconnecting() ? (attempt()?.state ?? "pending") : undefined,
        );
        const startingPreview = () =>
          tab().view === "preview" &&
          ["create-intended", "starting", "pausing", "paused", "resuming"].includes(
            attempt()?.state ?? "",
          ) &&
          !attempt()?.computeWait;
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
          if (attempt()?.restoreFailed) return restoreFailedHeadline;
          if (attempt()?.state === "resuming" && attempt()?.failure) return restoreUnknownHeadline;
          if (reconnecting()) return "Connection interrupted. Reconnecting to the same Workspace…";
          const current = attempt();
          if (current?.state === "cleanup-failed")
            return "Preview cleanup is unconfirmed. A new Start is blocked.";
          if (current?.runtimeKind === "staging" && current.state === "failed")
            return "Main Preview failed to start.";
          if (current?.computeWait)
            return "Waiting for execution capacity. The Preview starts automatically when space is available.";
          if (current && startingPreview())
            return previewStatus({
              attempt: current,
              app: app(),
              waited: waited(),
              phase: "loading",
            }).headline;
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
              loadingDetail={
                attempt()?.restoreFailed
                  ? restoreFailedDetail
                  : attempt()?.state === "resuming" && attempt()?.failure
                    ? restoreUnknownDetail
                    : startingPreview() && waited() >= 5_000
                      ? `${["starting", "create-intended"].includes(attempt()?.state ?? "") ? "Starting" : "Resuming"} for ${waitLabel(waited())}. Factory opens the Preview as soon as the App answers.`
                      : undefined
              }
              attempt={attempt()}
              app={app()}
              failure={
                reconnecting()
                  ? undefined
                  : attempt()?.state === "resuming" && attempt()?.failure
                    ? boundedCause(attempt()?.failure ?? "")
                    : plainFailure(attempt()?.failure ?? tab().preparationFailure)
              }
              restoreFailed={attempt()?.restoreFailed}
              onStartFresh={
                props.onStartFresh && attempt()?.restoreFailed
                  ? () => props.onStartFresh?.(tab()) ?? Promise.resolve()
                  : undefined
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
  loadingDetail?: string | undefined;
  attempt?: Pick<RuntimeAttempt, "state" | "failure" | "computeWait"> | undefined;
  app?: AppPreview | undefined;
  failure?: string | null | undefined;
  onRetry?: (() => Promise<void>) | undefined;
  onStartFresh?: (() => Promise<void>) | undefined;
  restoreFailed?: boolean | undefined;
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
  const [freshening, setFreshening] = createSignal(false);
  const [freshError, setFreshError] = createSignal("");
  async function startFresh() {
    if (freshening() || !props.onStartFresh) return;
    setFreshening(true);
    setFreshError("");
    try {
      await props.onStartFresh();
    } catch (cause) {
      setFreshError(
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "Start fresh could not be confirmed. Try again.",
      );
    } finally {
      setFreshening(false);
    }
  }
  async function retry() {
    if (retrying() || !props.onRetry) return;
    setRetrying(true);
    setRetryError("");
    try {
      await props.onRetry();
    } catch (cause) {
      setRetryError(
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "The Main Preview start could not be confirmed.",
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
            <Show when={props.loadingDetail}>{(detail) => <p aria-live="off">{detail()}</p>}</Show>
            <Show when={props.failure}>
              {(failure) => (
                <Show
                  when={props.onStartFresh || props.restoreFailed}
                  fallback={<p role="note">{failure()}</p>}
                >
                  <details class="runtime-cause">
                    <summary>Technical cause</summary>
                    <p role="note">
                      {failure().replace(/^The paused Sandbox could not be restored:\s*/, "")}
                    </p>
                  </details>
                </Show>
              )}
            </Show>
            <Show when={props.onStartFresh || freshening()}>
              <button
                type="button"
                class="primary-button"
                disabled={freshening()}
                aria-busy={freshening() ? "true" : undefined}
                onClick={() => void startFresh()}
              >
                {freshening() ? "Starting fresh…" : "Start fresh"}
              </button>
              <Show when={freshening()}>
                <p aria-live="polite">
                  Discarding the paused Sandbox, then starting a new one. This can take a minute.
                </p>
              </Show>
            </Show>
            <Show when={freshError()}>{(error) => <p role="alert">{error()}</p>}</Show>
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
            attempt={props.attempt}
            app={props.app}
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
  attempt?: Pick<RuntimeAttempt, "state" | "failure" | "computeWait"> | undefined;
  app?: AppPreview | undefined;
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
  const [delayed, setDelayed] = createSignal(false);
  const [documentFailed, setDocumentFailed] = createSignal(false);
  const [retryable, setRetryable] = createSignal(false);
  const [appStatus, setAppStatus] = createSignal<number>();
  const [manualReloads, setManualReloads] = createSignal(0);
  const waited = createWaitElapsed(() =>
    phase() === "loaded" ? undefined : `${props.url}:${manualReloads()}`,
  );
  const status = () =>
    previewStatus({
      attempt: props.attempt,
      app: props.app,
      waited: delayed() ? Math.max(waited(), 30_000) : Math.min(waited(), 29_999),
      phase: phase() === "failed" ? "failed" : "loading",
      unreachable: retryable(),
    });
  let attached = false;
  let retryDelay = 1000;
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
      attached = false;
      retryDelay = 1000;
      setRetryable(false);
      setDocumentFailed(false);
      setDelayed(false);
      setAppStatus(undefined);
      setPhase("loading");
    },
  );
  createEffect(
    () => ({ phase: phase(), delayed: delayed(), url: props.url }),
    (current) => {
      if (current.phase !== "loading") return;
      if (current.delayed) return;
      // Silence is not a failed navigation. Keep waiting on the same document;
      // offer a local reload without replaying App work or starting compute.
      const timer = setTimeout(() => setDelayed(true), 30_000);
      return () => clearTimeout(timer);
    },
  );
  createEffect(
    () => ({
      phase: phase(),
      retryable: retryable(),
      active: props.active !== false,
      reconnecting: props.reconnecting,
    }),
    (current) => {
      if (
        current.phase !== "failed" ||
        !current.retryable ||
        !current.active ||
        current.reconnecting
      )
        return;
      // Only Factory-confirmed initial document unavailability can retry.
      // Reconnect the same GET attachment, never Start, App writes or an
      // already attached document that may contain unsaved human input.
      const timer = setTimeout(() => {
        retryDelay = Math.min(retryDelay * 2, 10_000);
        reload(false);
      }, retryDelay);
      return () => clearTimeout(timer);
    },
  );
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
          setRetryable(!attached && event.data.retryable === true);
          setDocumentFailed(true);
          setPhase("failed");
          return;
        }
        // The document is attached even if a nonessential image is still loading.
        // This is not App health, runtime readiness or review evidence.
        attached = true;
        setAppStatus(typeof event.data.status === "number" ? event.data.status : undefined);
        setRetryable(false);
        setDocumentFailed(false);
        setDelayed(false);
        setPhase("loaded");
        usePreview(activePreviewID());
      };
      window.addEventListener("message", ready);
      return () => window.removeEventListener("message", ready);
    },
  );

  function reload(resetBackoff = true) {
    if (!frame) return;
    if (resetBackoff) {
      attached = false;
      retryDelay = 1000;
      setManualReloads((value) => value + 1);
    }
    setRetryable(false);
    setDocumentFailed(false);
    setDelayed(false);
    setAppStatus(undefined);
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
          // A failed cross-origin document also fires load. Only the Preview
          // bridge can confirm attachment and suppress retries over human work.
          setDelayed(false);
          setPhase(rejected ? "failed" : "loaded");
          if (!rejected) usePreview(activePreviewID());
        }}
        onError={() => {
          setDelayed(false);
          setPhase("failed");
        }}
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
      <Show when={phase() === "loaded" ? appResponseNotice(appStatus(), props.app) : undefined}>
        {(notice) => (
          <div class="runtime-app-notice" role="status">
            {notice()}
          </div>
        )}
      </Show>
      <Show when={phase() !== "loaded" || props.reconnecting}>
        <div
          class="runtime-frame-state empty-workspace"
          role="status"
          aria-label={`${props.title} connection`}
        >
          <Show
            when={props.title === "Preview" && !props.reconnecting}
            fallback={
              <p>
                {props.reconnecting
                  ? "Connection interrupted. Reconnecting to the same Workspace…"
                  : phase() === "failed"
                    ? "Could not open IDE. Reload this view to retry."
                    : delayed()
                      ? "IDE is taking longer to open. You can keep waiting."
                      : "Workspace is running. Opening IDE…"}
              </p>
            }
          >
            <p>
              {phase() === "failed" && retryable()
                ? "Preview could not be reached. Reconnecting…"
                : status().headline}
            </p>
            <Show when={status().cause}>{(cause) => <p role="note">{cause()}</p>}</Show>
            <Show when={phase() === "failed" || delayed() ? status().detail : undefined}>
              {(detail) => <p>{detail()}</p>}
            </Show>
            <Show when={waited() >= 5_000}>
              <p aria-live="off">
                {phase() === "failed" ? "Trying for" : "Waiting for"} {waitLabel(waited())}.
              </p>
            </Show>
          </Show>
          <Show when={!props.reconnecting && (phase() === "failed" || delayed())}>
            <button
              type="button"
              class={phase() === "failed" ? "primary-button" : "quiet-button"}
              onClick={() => reload()}
            >
              Reload view
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
