import { createEffect, createSignal, Show } from "solid-js";
import type { ConversationMode } from "../../../../packages/conversation-domain/src/conversation";
import {
  type InheritedModelSettingsView,
  inheritedModelSettingsView,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import {
  type InheritedSkillSettings,
  inheritedSkillSettingsView,
} from "../../../../packages/conversation-domain/src/skill-inheritance";
import type { TurnObservation } from "../../../../packages/conversation-domain/src/turn-observation";
import { apiRequest } from "../api-client";
import { projectFailureNotice } from "./failure-notice";

export function AgentBlockers(props: {
  projectID: string | undefined;
  mode: ConversationMode;
  turn: TurnObservation | undefined;
  settingsOpen: boolean;
  onSettings: (opener: HTMLElement) => void;
}) {
  const [configuration, setConfiguration] = createSignal<{
    models: InheritedModelSettingsView;
    skills: InheritedSkillSettings;
  }>();
  const [error, setError] = createSignal("");
  const [refresh, setRefresh] = createSignal(0);
  createEffect(
    () => [props.projectID, props.settingsOpen, props.turn?.id, refresh()] as const,
    ([projectID, settingsOpen]) => {
      setConfiguration(undefined);
      setError("");
      if (!projectID || settingsOpen) return;
      const abort = new AbortController();
      void Promise.all([
        apiRequest(inheritedModelSettingsView, `/api/projects/${projectID}/model-settings`, {
          signal: abort.signal,
        }),
        apiRequest(inheritedSkillSettingsView, `/api/projects/${projectID}/skill-settings`, {
          signal: abort.signal,
        }),
      ])
        .then(([models, skills]) => {
          if (!abort.signal.aborted) setConfiguration({ models, skills });
        })
        .catch((cause: unknown) => {
          if (!abort.signal.aborted)
            setError(
              cause instanceof Error
                ? cause.message
                : "Configuration unavailable. Open Agent settings to check access.",
            );
        });
      return () => abort.abort();
    },
  );
  const role = () => (props.mode === "build" ? "build" : "planning");
  const retainedBuild = () => props.mode === "build" && props.turn?.engine === "opencode";
  const defaults = () => {
    const value = configuration();
    if (!value) return undefined;
    return {
      model: value.models.effective[role()],
      skills: value.skills.effective[role()],
      providerConfigured: value.models.system.connection.configured,
    };
  };
  const blocked = () => {
    const value = defaults();
    if (!value) return undefined;
    if (!value.providerConfigured)
      return "Provider not configured. Ask a System Manager to configure the server credentials.";
    if (!retainedBuild() && !value.model.available)
      return "Default model is not permitted. Ask a manager to change the role default or allowed models.";
    if (!retainedBuild() && !value.skills.available)
      return "An assigned Skill is unavailable. Ask a manager to restore publication or change the assignment.";
    return undefined;
  };
  return (
    <>
      <Show
        when={
          props.turn?.engine === "mastra" &&
          ["uncertain", "failed", "stopped"].includes(props.turn.state)
        }
      >
        <p class="agent-configuration-note" role="alert">
          {props.turn ? projectFailureNotice(props.turn) : ""}
        </p>
      </Show>
      <Show when={blocked() || error()}>
        <p class="agent-configuration-note" role="status">
          {blocked() ?? error()}
        </p>
      </Show>
      <Show when={blocked() || error()}>
        <div class="agent-configuration-actions">
          <button
            type="button"
            class="quiet-button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry
          </button>
          <button
            type="button"
            class="quiet-button"
            onClick={(event) => props.onSettings(event.currentTarget)}
          >
            Open settings
          </button>
        </div>
      </Show>
    </>
  );
}
