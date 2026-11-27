import { Show } from "solid-js";
import { buildAgentActivityNotice, buildAgentHint, buildAgentStatus } from "../agent-view-state";
import type { AssistantPanelModel } from "./assistant-panel-model";

export function AssistantStatusNotices(props: { model: AssistantPanelModel }) {
  return (
    <>
      <Show when={props.model.preparingImplementation()}>
        <div class="agent-status">
          <span class="agent-state">Ready to build</span>
          <button
            type="button"
            class="quiet-button"
            onClick={() => props.model.setImplementationPreparation(undefined)}
          >
            Back to conversation
          </button>
        </div>
      </Show>
      <Show when={props.model.conversationMode() === "build" && props.model.selectedChange()}>
        <div class="agent-status">
          <span class="agent-state">
            {!props.model.agentViewLoaded()
              ? "Loading implementation…"
              : props.model.agent().state === "idle" && !props.model.agentCanRun()
                ? "Build unavailable"
                : buildAgentStatus(props.model.agent())}
          </span>
          <span class={`runtime-presence ${props.model.ticketWorkspaceReady() ? "ready" : ""}`}>
            <i />
            {props.model.ticketWorkspaceStatus()}
          </span>
        </div>
      </Show>
      <Show
        when={
          props.model.conversationMode() === "build" &&
          props.model.selectedChange() &&
          props.model.agent().stopPending
        }
      >
        <section class="agent-stop-notice" aria-label="Stop recovery">
          <p class="agent-stop-copy" role="status">
            Stop saved. OpenCode confirmation is still missing. New Build work is blocked.
          </p>
          <details>
            <summary class="agent-stop-explanation">Why is Build blocked?</summary>
            <p class="agent-stop-detail">
              {props.model.agent().lastError?.startsWith("Stop remains unconfirmed.")
                ? props.model.agent().lastError
                : "Factory cannot yet prove that execution and queued input are settled."}
            </p>
            <p class="agent-stop-detail">
              Factory will not resend uncertain commands. Stop does not roll back workspace edits.
            </p>
            <Show
              when={
                props.model.agent().runtimeState !== "ready" ||
                !props.model.agent().messagesAvailable
              }
            >
              <p class="agent-stop-detail">
                Live workspace status is unavailable. Queued input may survive a restart;
                reconnecting alone does not confirm Stop.
              </p>
            </Show>
            <p class="agent-stop-detail">
              Checking status only reads the current outcome. It does not restart work.
            </p>
            <Show when={props.model.agent().stopId}>
              <p class="agent-stop-detail">
                Recheck confirmation checks OpenCode and saves confirmation only when it can prove
                this Stop. It will not resend interruption, cancel input or start compute.
              </p>
              <button
                type="button"
                class="agent-control agent-stop-check"
                disabled={props.model.pending()}
                onClick={() => void props.model.recheckStopConfirmation()}
              >
                Recheck confirmation
              </button>
            </Show>
          </details>
          <button
            type="button"
            class="agent-control agent-stop-check"
            disabled={props.model.pending()}
            onClick={() => void props.model.checkStopStatus()}
          >
            Check Stop status
          </button>
        </section>
      </Show>
      <Show
        when={
          props.model.conversationMode() === "build" &&
          props.model.selectedChange() &&
          props.model.agent().commitOperation &&
          !props.model.agent().stopPending
        }
      >
        <p class="agent-activity-notice" role="status" aria-label="Commit recovery">
          {buildAgentHint(props.model.agent())}
        </p>
      </Show>
      <Show
        when={
          props.model.conversationMode() === "build" &&
          props.model.selectedChange() &&
          buildAgentActivityNotice(props.model.agent())
        }
      >
        <p class="agent-activity-notice" role="status">
          {buildAgentActivityNotice(props.model.agent())}
        </p>
      </Show>
      <Show
        when={
          props.model.conversationMode() === "build" &&
          props.model.selectedChange() &&
          props.model.agent().state === "working" &&
          !props.model.agent().runtimeConnected &&
          !props.model.agent().stopPending &&
          !props.model.agent().commitOperation
        }
      >
        <p class="agent-activity-notice" role="status" aria-label="Build connection">
          {buildAgentHint(props.model.agent())}
        </p>
      </Show>
    </>
  );
}
