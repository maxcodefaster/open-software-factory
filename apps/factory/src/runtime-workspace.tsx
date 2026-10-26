import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { workspacePresence } from "../../../packages/interface-domain/src/workspace-presence";
import type { AppPreview, RuntimeAttempt } from "./api-contracts";
import { runtimeReconnecting, runtimeWorkspaceURL } from "./runtime-workspace-state";
import type { WorkspaceTab } from "./workspace-tabs";
import { PreviewReview } from "./review/preview";
import { appRuntimeOrigin } from "./runtime-origins";

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
            changeID,
            userID: props.userID,
            canDevelop: props.canDevelop,
            onOpenTicket: props.onOpenTicket ? () => props.onOpenTicket?.(changeID) : undefined,
          };
        });
        const status = () => {
          if (reconnecting()) return "Connection interrupted. Reconnecting to the same Workspace…";
          const current = attempt();
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
              url={url()}
              reconnecting={reconnecting()}
              loadingLabel={status()}
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
  url?: string | undefined;
  loadingLabel: string;
  reconnecting?: boolean;
  active?: boolean | undefined;
  review?:
    | {
        changeID: string;
        userID: string;
        canDevelop: boolean;
        onOpenTicket?: (() => void) | undefined;
      }
    | undefined;
}) {
  return (
    <div class="runtime-workspace">
      <Show
        when={props.url}
        fallback={
          <div class="empty-workspace" role="status">
            <p>{props.loadingLabel}</p>
          </div>
        }
      >
        {(url) => (
          <AttachedRuntimeFrame
            title={props.title}
            attemptID={props.attemptID}
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
  url: string;
  reconnecting?: boolean;
  active?: boolean | undefined;
  review?:
    | {
        changeID: string;
        userID: string;
        canDevelop: boolean;
        onOpenTicket?: (() => void) | undefined;
      }
    | undefined;
}) {
  const [phase, setPhase] = createSignal<"loading" | "loaded" | "failed">("loading");
  let frame: HTMLIFrameElement | undefined;
  function usePreview() {
    if (props.title !== "Preview" || !props.attemptID || props.active === false) return;
    frame?.contentWindow?.postMessage(
      { type: "factory-runtime-use" },
      appRuntimeOrigin(location.origin, props.attemptID, "app"),
    );
  }
  createEffect(
    () => [props.active, props.attemptID] as const,
    () => usePreview(),
  );
  createEffect(
    () => props.url,
    () => {
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
    () => ({ preview: props.title === "Preview", attemptID: props.attemptID }),
    (current) => {
      if (!current.preview || !current.attemptID) return;
      const origin = appRuntimeOrigin(location.origin, current.attemptID, "app");
      const ready = (event: MessageEvent) => {
        if (
          event.origin !== origin ||
          event.source !== frame?.contentWindow ||
          !event.data ||
          typeof event.data !== "object" ||
          event.data.type !== "factory-preview-document-ready"
        )
          return;
        // The document is attached even if a nonessential image is still loading.
        // This is not App health, runtime readiness or review evidence.
        setPhase("loaded");
        usePreview();
      };
      window.addEventListener("message", ready);
      return () => window.removeEventListener("message", ready);
    },
  );

  function reload() {
    if (!frame) return;
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
          setPhase(accessRejected ? "failed" : "loaded");
          if (!accessRejected) usePreview();
        }}
        onError={() => setPhase("failed")}
      />
      <Show
        when={props.title === "Preview" && props.review && props.attemptID && phase() === "loaded"}
      >
        <PreviewReview
          changeID={props.review!.changeID}
          attemptID={props.attemptID!}
          userID={props.review!.userID}
          canDevelop={props.review!.canDevelop}
          active={props.active !== false}
          onOpenTicket={props.review!.onOpenTicket}
          frame={() => frame}
          runtimeOrigin={appRuntimeOrigin(location.origin, props.attemptID!, "app")}
        />
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
