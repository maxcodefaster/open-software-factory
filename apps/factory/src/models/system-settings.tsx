import { createEffect, createSignal, For, Show } from "solid-js";
import {
  type ModelRole,
  modelRoles,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import {
  type ModelSettingsView,
  modelSettingsView,
} from "../../../../packages/conversation-domain/src/model-settings";
import { apiRequest } from "../api-client";
import { ModelConnectionSettings } from "./connection-settings";

export function SystemModelSettings(props: { active?: boolean }) {
  const [settings, setSettings] = createSignal<ModelSettingsView>();
  const [planning, setPlanning] = createSignal("");
  const [build, setBuild] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const [rules, setRules] = createSignal<ModelSettingsView["rules"]>();
  let disposed = false;
  const dirty = () =>
    planning() !== settings()?.planningModelId ||
    build() !== settings()?.buildModelId ||
    JSON.stringify(rules()) !== JSON.stringify(settings()?.rules);

  function publish(value: ModelSettingsView) {
    setSettings(value);
    setPlanning(value.planningModelId);
    setBuild(value.buildModelId);
    setRules(value.rules);
  }
  async function load() {
    setBusy(true);
    setError("");
    try {
      const value = await apiRequest(modelSettingsView, "/api/model-settings");
      if (!disposed) publish(value);
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load models");
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const current = settings();
    if (!current || busy()) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const value = await apiRequest(modelSettingsView, "/api/model-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: current.version,
          planningModelId: planning(),
          buildModelId: build(),
          rules: rules(),
        }),
      });
      if (!disposed) {
        publish(value);
        setSaved(true);
      }
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Could not save models");
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  createEffect(
    () => props.active,
    (active) => {
      if (active && settings() && !busy() && !dirty()) void load();
    },
  );
  createEffect(
    () => true,
    () => {
      void load();
      return () => {
        disposed = true;
      };
    },
  );

  return (
    <div class="model-settings-body">
      <ModelConnectionSettings
        settingsVersion={settings()?.version ?? 0}
        onChange={() => void load()}
      />
      <Show
        when={settings()}
        fallback={<p role="status">{busy() ? "Loading models…" : "Models could not be loaded."}</p>}
      >
        {(current) => (
          <>
            <p class="model-settings-note">
              Research, requirements &amp; Wiki: {current().planningModelId || "Not selected"}
              <br />
              Implementation: {current().buildModelId || "Not selected"}
            </p>
            <form onSubmit={(event) => void save(event)}>
              <p class="model-settings-note">
                Existing Changes keep their original Build model. Running turns are never
                reconfigured.
              </p>
              <details class="model-policy">
                <summary>Model override permissions</summary>
                <For each={modelRoles}>
                  {(role) => (
                    <SystemRoleRules
                      role={role}
                      models={current().models}
                      rule={rules()?.[role] ?? current().rules[role]}
                      busy={busy()}
                      onChange={(value) => {
                        setRules((previous) => ({
                          ...(previous ?? current().rules),
                          [role]: value,
                        }));
                        setSaved(false);
                      }}
                    />
                  )}
                </For>
                <footer class="model-settings-actions">
                  <span role="status">
                    {saved()
                      ? "Defaults saved"
                      : current().source === "environment"
                        ? "Using environment defaults"
                        : "Administrator defaults"}
                  </span>
                  <button
                    type="submit"
                    class="primary-button"
                    disabled={
                      busy() ||
                      (!dirty() && current().source !== "environment") ||
                      !current().models.includes(planning()) ||
                      !current().models.includes(build())
                    }
                  >
                    {busy() ? "Saving…" : "Save permissions"}
                  </button>
                </footer>
              </details>
            </form>
          </>
        )}
      </Show>
      <Show when={error()}>
        <div class="model-settings-error">
          <p role="alert">{error()}</p>
          <button type="button" class="quiet-button" disabled={busy()} onClick={() => void load()}>
            Reload settings
          </button>
        </div>
      </Show>
    </div>
  );
}

function SystemRoleRules(props: {
  role: ModelRole;
  models: string[];
  rule: ModelSettingsView["rules"][ModelRole];
  busy: boolean;
  onChange: (value: ModelSettingsView["rules"][ModelRole]) => void;
}) {
  const label = () => (props.role === "planning" ? "Planning" : "Build");
  return (
    <details class="model-policy">
      <summary>{label()} permissions</summary>
      <label class="model-checkbox">
        <input
          type="checkbox"
          checked={props.rule.allowOverride}
          disabled={props.busy}
          onChange={(event) =>
            props.onChange({ ...props.rule, allowOverride: event.currentTarget.checked })
          }
        />
        Allow Project and personal overrides
      </label>
      <fieldset>
        <legend>Permitted {label().toLowerCase()} models</legend>
        <For each={props.models}>
          {(id) => (
            <label class="model-checkbox">
              <input
                type="checkbox"
                checked={props.rule.models.includes(id)}
                disabled={props.busy}
                onChange={(event) =>
                  props.onChange({
                    ...props.rule,
                    models: event.currentTarget.checked
                      ? [...props.rule.models, id]
                      : props.rule.models.filter((model) => model !== id),
                  })
                }
              />
              {id}
            </label>
          )}
        </For>
      </fieldset>
    </details>
  );
}
