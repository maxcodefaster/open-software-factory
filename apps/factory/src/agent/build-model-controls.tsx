import { createEffect, createSignal, For, Show, createUniqueId, onCleanup } from "solid-js";
import { type InheritedModelSettingsView } from "../../../../packages/conversation-domain/src/model-inheritance";
import {
  codingReasoningInput,
  type CodingReasoning,
} from "../../../../packages/conversation-domain/src/model-settings";
import type { TurnObservation } from "../../../../packages/conversation-domain/src/turn-observation";
import { invoke } from "@solidjs/web/server-functions/client";
import { getProjectModels } from "../server-functions/models";
import { serverCall } from "../server-functions/result";
import { reasoningLabels } from "../models/reasoning";

export function BuildModelControls(props: {
  projectID: string | undefined;
  changeID: string | undefined;
  turn: TurnObservation | undefined;
  sessionAvailable: boolean;
  disabled: boolean;
  reasoning: CodingReasoning | undefined;
  onChange: (reasoning: CodingReasoning | undefined) => void;
}) {
  const id = createUniqueId();
  const [settings, setSettings] = createSignal<InheritedModelSettingsView>();
  const [error, setError] = createSignal(false);
  let loadedScope: string | undefined;
  let currentRequest: AbortController | undefined;
  onCleanup(() => currentRequest?.abort());
  createEffect(
    () => `${props.projectID ?? ""}:${props.changeID ?? ""}`,
    (scope) => {
      if (scope === loadedScope) return;
      loadedScope = scope;
      currentRequest?.abort();
      const projectID = scope.split(":")[0];
      setSettings(undefined);
      setError(false);
      if (!projectID) return;
      const abort = new AbortController();
      currentRequest = abort;
      void serverCall(invoke(getProjectModels, { signal: abort.signal }, projectID))
        .then((value) => {
          if (!abort.signal.aborted) setSettings(value);
        })
        .catch(() => {
          if (!abort.signal.aborted) setError(true);
        });
    },
  );
  const frozen = () => props.turn?.engine === "opencode" || props.sessionAvailable;
  const supported = () =>
    frozen()
      ? Boolean(props.turn?.codingReasoning)
      : settings()?.system.connection.buildProvider === "openai";
  const model = () =>
    props.turn?.modelId ??
    (props.sessionAvailable ? "Session model" : settings()?.effective.build.modelId);
  const modelLabel = () => model() ?? (error() ? "Model unavailable" : "Loading model…");
  const help = () =>
    frozen()
      ? "Fixed for this Change."
      : error()
        ? "Model settings could not be loaded. Reopen the chat to retry."
        : "Reasoning for the first Build. Existing Changes keep their admitted model and reasoning.";
  return (
    <div class="agent-model-controls" title={`${modelLabel()}. ${help()}`}>
      <label class="sr-only" for={`${id}-reasoning`}>
        Reasoning
      </label>
      <select
        id={`${id}-reasoning`}
        aria-describedby={`${id}-help`}
        value={frozen() ? (props.turn?.codingReasoning ?? "") : (props.reasoning ?? "")}
        disabled={props.disabled || frozen() || !supported()}
        onChange={(event) =>
          props.onChange(
            event.currentTarget.value
              ? codingReasoningInput.parse(event.currentTarget.value)
              : undefined,
          )
        }
      >
        <Show when={!frozen() || !props.turn?.codingReasoning}>
          <option value="">
            {supported() && settings()
              ? `${modelLabel()} · ${reasoningLabels[settings()?.system.rules.build.reasoningEffort ?? "medium"]} · default`
              : `${modelLabel()} · Provider default`}
          </option>
        </Show>
        <Show when={supported()}>
          <For each={codingReasoningInput.options}>
            {(value) => (
              <option value={value}>
                {modelLabel()} · {reasoningLabels[value]}
              </option>
            )}
          </For>
        </Show>
      </select>
      <span class="sr-only" id={`${id}-help`}>
        {help()}
      </span>
    </div>
  );
}
