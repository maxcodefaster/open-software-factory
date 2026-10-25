import { createEffect, createSignal, For, Show } from "solid-js";
import {
  type InheritedModelSettingsView,
  type ModelRole,
  modelRoles,
  type ProjectModelSettings as ProjectSettings,
  type PersonalModelSettings,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import {
  getProjectModels,
  saveProjectModels,
  savePersonalModels,
} from "../server-functions/models";
import { serverCall } from "../server-functions/result";

export function ProjectModelSettings(props: {
  projectID: string;
  management: boolean;
  active?: boolean;
}) {
  const [view, setView] = createSignal<InheritedModelSettingsView>();
  const [project, setProject] = createSignal<ProjectSettings>();
  const [personal, setPersonal] = createSignal<PersonalModelSettings>();
  const management = () => props.management && view()?.canManageProject === true;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  let disposed = false;
  const dirty = (manage = management()) =>
    JSON.stringify(manage ? project() : personal()) !==
    JSON.stringify(manage ? view()?.project : view()?.personal);
  function publish(value: InheritedModelSettingsView) {
    setView(value);
    setProject(value.project);
    setPersonal(value.personal);
  }
  async function load(projectID = props.projectID) {
    setBusy(true);
    setError("");
    try {
      const value = await serverCall(getProjectModels(projectID));
      if (!disposed && projectID === props.projectID) publish(value);
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load models");
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || !view()) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const projectInput = project();
      const personalInput = personal();
      if (!projectInput || !personalInput) return;
      const value = await serverCall(
        management()
          ? saveProjectModels(props.projectID, projectInput)
          : savePersonalModels(props.projectID, personalInput),
      );
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
  function select(role: ModelRole, id: string | null) {
    if (management())
      setProject((previous) =>
        previous ? { ...previous, [role]: { ...previous[role], modelId: id } } : previous,
      );
    else
      setPersonal((previous) =>
        previous
          ? { ...previous, [role === "planning" ? "planningModelId" : "buildModelId"]: id }
          : previous,
      );
    setSaved(false);
  }
  function selection(role: ModelRole) {
    return management()
      ? project()?.[role].modelId
      : role === "planning"
        ? personal()?.planningModelId
        : personal()?.buildModelId;
  }
  createEffect(
    () => ({ active: props.active, management: props.management, projectID: props.projectID }),
    ({ active, management, projectID }) => {
      if (active && view() && !busy() && !dirty(management && view()?.canManageProject === true))
        void load(projectID);
    },
  );
  createEffect(
    () => props.projectID,
    (projectID) => {
      disposed = false;
      setView(undefined);
      void load(projectID);
      return () => {
        disposed = true;
      };
    },
  );
  return (
    <div class="model-settings-body">
      <Show
        when={view()}
        fallback={<p role="status">{busy() ? "Loading models…" : "Models could not be loaded."}</p>}
      >
        {(current) => (
          <>
            <form onSubmit={(event) => void save(event)}>
              <For each={modelRoles}>
                {(role) => {
                  const label = () => (role === "planning" ? "Investigate & Plan" : "Build");
                  const effective = () =>
                    management() ? current().projectEffective[role] : current().effective[role];
                  const allowed = () =>
                    management()
                      ? current().system.rules[role].models.filter((id) =>
                          current().system.models.includes(id),
                        )
                      : effective().models;
                  const locked = () =>
                    management()
                      ? !current().system.rules[role].allowOverride
                      : !effective().allowOverride;
                  return (
                    <section class="model-role" aria-label={`${label()} configuration`}>
                      <label for={`${role}-project-model`}>
                        <strong>{label()}</strong>
                        <span>
                          {role === "planning" ? "Research and requirements" : "Implementation"}
                        </span>
                      </label>
                      <div class="model-effective">
                        <strong>{effective().modelId}</strong>
                        <small>
                          {effective().source === "personal"
                            ? "My selection"
                            : effective().source === "project"
                              ? "Inherited from Project"
                              : "Inherited from Factory"}
                          {!effective().available ? " · unavailable" : ""}
                        </small>
                      </div>
                      <div class="model-selection">
                        <select
                          id={`${role}-project-model`}
                          value={selection(role) ?? ""}
                          disabled={busy() || locked()}
                          onChange={(event) => select(role, event.currentTarget.value || null)}
                        >
                          <option value="">Use inherited default</option>
                          <Show
                            when={selection(role) && !allowed().includes(selection(role) ?? "")}
                          >
                            <option value={selection(role) ?? ""}>
                              {selection(role)} · no longer permitted
                            </option>
                          </Show>
                          <For each={allowed()}>{(id) => <option value={id}>{id}</option>}</For>
                        </select>
                        <button
                          type="button"
                          class="quiet-button"
                          disabled={busy() || selection(role) == null}
                          onClick={() => select(role, null)}
                          aria-label={`Reset ${label()}`}
                        >
                          Reset
                        </button>
                      </div>
                      <Show when={locked()}>
                        <p class="model-settings-note">
                          {management() ? "Locked by Factory policy" : effective().lockedReason}
                        </p>
                      </Show>
                      <Show when={effective().ignoredReason}>
                        <p class="model-settings-note">{effective().ignoredReason}</p>
                      </Show>
                      <Show when={management()}>
                        <details class="model-policy">
                          <summary>{label()} permissions</summary>
                          <label class="model-checkbox">
                            <input
                              type="checkbox"
                              checked={project()?.[role].allowOverride !== false}
                              disabled={busy() || locked()}
                              onChange={(event) => {
                                const allowOverride = event.currentTarget.checked ? null : false;
                                setProject((previous) =>
                                  previous
                                    ? { ...previous, [role]: { ...previous[role], allowOverride } }
                                    : previous,
                                );
                                setSaved(false);
                              }}
                            />
                            Allow personal overrides
                          </label>
                          <fieldset>
                            <legend>Permitted models</legend>
                            <For each={allowed()}>
                              {(id) => (
                                <label class="model-checkbox">
                                  <input
                                    type="checkbox"
                                    disabled={busy()}
                                    checked={project()?.[role].models?.includes(id) ?? true}
                                    onChange={(event) => {
                                      const checked = event.currentTarget.checked;
                                      setProject((previous) => {
                                        if (!previous) return previous;
                                        const ids = previous[role].models ?? allowed();
                                        return {
                                          ...previous,
                                          [role]: {
                                            ...previous[role],
                                            models: checked
                                              ? [...new Set([...ids, id])]
                                              : ids.filter((model) => model !== id),
                                          },
                                        };
                                      });
                                      setSaved(false);
                                    }}
                                  />
                                  {id}
                                </label>
                              )}
                            </For>
                          </fieldset>
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={busy()}
                            onClick={() => {
                              setProject((previous) =>
                                previous
                                  ? {
                                      ...previous,
                                      [role]: { modelId: null, models: null, allowOverride: null },
                                    }
                                  : previous,
                              );
                              setSaved(false);
                            }}
                          >
                            Reset {label()} rules to System
                          </button>
                        </details>
                      </Show>
                    </section>
                  );
                }}
              </For>
              <p class="model-settings-note">
                Selections apply to new work. Running implementations keep their original model.
              </p>
              <footer class="model-settings-actions">
                <span role="status">
                  {saved()
                    ? "Model settings saved"
                    : management()
                      ? "Editing Project defaults"
                      : "Editing my models"}
                </span>
                <button type="submit" class="primary-button" disabled={busy() || !dirty()}>
                  {busy() ? "Saving…" : "Save models"}
                </button>
              </footer>
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
