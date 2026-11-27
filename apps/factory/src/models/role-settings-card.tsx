import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import type { ModelProbeResult } from "#conversation-domain/model-connection";
import { codingReasoningInput, type ModelSettingsView } from "#conversation-domain/model-settings";
import {
  availableModelsForRole,
  type Catalogue,
  connectionLabel,
  describeRoleAccessStatus,
  initialRoleDraft,
  type ModelRole,
  type RoleDraftState,
  type RoleSelection,
} from "./connection-state";
import { modelProbeExplanation } from "./probe-explanation";
import { reasoningLabels } from "./reasoning";

export function ModelRoleSettingsCard(props: {
  role: ModelRole;
  data: Catalogue;
  settings: ModelSettingsView;
  disabled: boolean;
  checking: boolean;
  resetDrafts: number;
  onSave: (selection: RoleSelection) => Promise<ModelProbeResult | undefined>;
  onStop: () => void;
}) {
  const [draft, setDraft] = createSignal<RoleDraftState>(
    untrack(() => initialRoleDraft(props.data, props.settings, props.role)),
  );
  let lastReset = untrack(() => props.resetDrafts);

  const label = () => (props.role === "build" ? "Coding" : "Planning & knowledge");
  const active = () => props.data.roles.find((entry) => entry.role === props.role);
  const deployment = () =>
    props.data.deployment.find((entry) => entry.role === props.role && entry.configured);
  const connection = () =>
    props.data.connections.find((entry) => entry.connectionID === draft().connectionID) ??
    props.data.deployment.find(
      (entry) => entry.connectionID === draft().connectionID && entry.configured,
    );
  const connectionSummary = () => {
    const value = connection();
    return value ? `Via ${connectionLabel(value)}` : "Choose a connection";
  };
  const models = () =>
    availableModelsForRole({
      data: props.data,
      role: props.role,
      model: draft().model,
      provider: connection()?.provider,
    });

  createEffect(
    () => ({
      data: props.data,
      settings: props.settings,
      reset: props.resetDrafts,
      role: props.role,
    }),
    ({ data, settings, reset, role }) => {
      if (untrack(draft).dirty && lastReset === reset) return;
      lastReset = reset;
      setDraft(initialRoleDraft(data, settings, role));
    },
  );

  function updateDraft(patch: Partial<RoleDraftState>) {
    setDraft((current) => ({ ...current, ...patch, dirty: true, result: undefined }));
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const current = draft();
    const checked = await props.onSave({
      connectionID: current.connectionID,
      modelId: current.model.trim(),
      ...(props.role === "build" && connection()?.provider === "openai"
        ? { reasoningEffort: current.reasoning }
        : {}),
    });
    if (!checked) return;
    setDraft((state) => ({
      ...state,
      result: checked,
      ...(checked.status === "ready"
        ? { dirty: false, custom: false, model: checked.modelId }
        : {}),
    }));
  }

  const accessStatus = () =>
    describeRoleAccessStatus({
      checking: props.checking,
      active: active(),
      deploymentConfigured: Boolean(deployment()),
      endpoint: connection()?.endpoint,
    });

  return (
    <section class="model-default-row" aria-label={label()}>
      <header>
        <h3>{label()}</h3>
        <p class="model-settings-note">
          {props.role === "build"
            ? "Implements approved changes."
            : "Research, requirements and Wiki."}
        </p>
        <small>{accessStatus()}</small>
      </header>
      <form onSubmit={(event) => void save(event)}>
        <div
          class={`model-choice-row${props.role === "build" && connection()?.provider === "openai" ? " with-reasoning" : ""}`}
        >
          <div class="model-role">
            <label for={`${props.role}-model`}>Model</label>
            <select
              id={`${props.role}-model`}
              value={draft().custom ? "__custom" : draft().model}
              disabled={props.disabled || !connection()}
              onChange={(event) => {
                const value = event.currentTarget.value;
                updateDraft({
                  custom: value === "__custom",
                  model: value === "__custom" ? "" : value,
                });
              }}
            >
              <option value="">Choose a model</option>
              <For each={models()}>
                {(id) => (
                  <option value={id} selected={!draft().custom && draft().model === id}>
                    {id}
                  </option>
                )}
              </For>
              <option value="__custom">Other model / Azure deployment…</option>
            </select>
          </div>
          <Show when={props.role === "build" && connection()?.provider === "openai"}>
            <div class="model-role">
              <label for="coding-reasoning">Reasoning</label>
              <select
                id="coding-reasoning"
                value={draft().reasoning}
                disabled={props.disabled}
                onChange={(event) =>
                  updateDraft({
                    reasoning: codingReasoningInput.parse(event.currentTarget.value),
                  })
                }
              >
                <For each={codingReasoningInput.options}>
                  {(value) => <option value={value}>{reasoningLabels[value]}</option>}
                </For>
              </select>
            </div>
          </Show>
        </div>
        <Show when={draft().custom}>
          <div class="model-role">
            <label for={`${props.role}-custom-model`}>Model or deployment ID</label>
            <input
              id={`${props.role}-custom-model`}
              value={draft().model}
              disabled={props.disabled}
              required
              placeholder="Exact provider model or Azure deployment ID"
              onInput={(event) => updateDraft({ model: event.currentTarget.value })}
            />
          </div>
        </Show>
        <footer class="model-role-footer">
          <details class="model-role-connection">
            <summary title={connection()?.endpoint ?? undefined}>{connectionSummary()}</summary>
            <div class="model-role">
              <label for={`${props.role}-connection`}>Connection</label>
              <select
                id={`${props.role}-connection`}
                value={draft().connectionID}
                disabled={props.disabled}
                onChange={(event) =>
                  updateDraft({
                    connectionID: event.currentTarget.value,
                    model: "",
                    custom: false,
                  })
                }
              >
                <option value="" selected={!draft().connectionID}>
                  Choose a connection
                </option>
                <For each={props.data.connections.filter((entry) => entry.configured)}>
                  {(entry) => (
                    <option
                      value={entry.connectionID}
                      selected={entry.connectionID === draft().connectionID}
                    >
                      {connectionLabel(entry)}
                    </option>
                  )}
                </For>
                <For
                  each={props.data.deployment.filter(
                    (entry) =>
                      entry.configured &&
                      !props.data.connections.some(
                        (saved) => saved.connectionID === entry.connectionID && saved.configured,
                      ),
                  )}
                >
                  {(entry) => (
                    <option
                      value={entry.connectionID}
                      selected={entry.connectionID === draft().connectionID}
                    >
                      {connectionLabel(entry)} · deployment
                    </option>
                  )}
                </For>
              </select>
            </div>
          </details>
          <div class="model-role-actions">
            <Show when={props.checking}>
              <button type="button" class="quiet-button" onClick={props.onStop}>
                Stop check
              </button>
            </Show>
            <button
              type="submit"
              class="primary-button"
              disabled={props.disabled || !connection() || !draft().model.trim()}
            >
              {props.checking ? "Checking…" : "Save & check"}
            </button>
          </div>
        </footer>
        <Show when={draft().result}>
          {(checked) => (
            <p role="status" class="model-settings-note">
              {checked().status === "ready"
                ? "Model saved. Access checked."
                : `Not saved. ${modelProbeExplanation(checked().status, connection()?.endpoint)} Previous settings remain active.`}
            </p>
          )}
        </Show>
      </form>
    </section>
  );
}
