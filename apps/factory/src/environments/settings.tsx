import { createEffect, createSignal, For, Show } from "solid-js";
import {
  environmentSettingsView,
  parseEnvironmentPaste,
  type EnvironmentSettingsView,
  type EnvironmentWrite,
  type ProjectEnvironment,
} from "../../../../packages/project-domain/src/environment";
import { apiRequest } from "../api-client";
import "./settings.css";

export function EnvironmentSettings(props: { projectID: string }) {
  const [environment, setEnvironment] = createSignal<ProjectEnvironment>("development");
  const [view, setView] = createSignal<EnvironmentSettingsView>();
  const [variables, setVariables] = createSignal<EnvironmentWrite["variables"]>([]);
  const [registries, setRegistries] = createSignal<EnvironmentWrite["registries"]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [paste, setPaste] = createSignal("");
  const [preview, setPreview] = createSignal<Array<{ name: string; value: string }>>([]);
  let generation = 0;
  let retry: EnvironmentWrite | undefined;
  const editable = () =>
    view()?.canManage === true &&
    view()?.storeConfigured === true &&
    !busy() &&
    (!view()?.pending || Boolean(retry));
  const path = () => `/api/projects/${props.projectID}/environments/${environment()}`;
  function publish(value: EnvironmentSettingsView) {
    setView(value);
    setVariables(value.variables.map((item) => ({ ...item })));
    setRegistries(
      value.registries.map(
        ({ hasPassword: _password, hasCertificate: _certificate, ...item }) => item,
      ),
    );
  }
  function changeVariable(index: number, patch: Partial<EnvironmentWrite["variables"][number]>) {
    if (retry) return;
    retry = undefined;
    setVariables((items) =>
      items.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
    setNotice("");
  }
  function changeRegistry(index: number, patch: Partial<EnvironmentWrite["registries"][number]>) {
    if (retry) return;
    retry = undefined;
    setRegistries((items) =>
      items.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
    setNotice("");
  }
  async function discardPending() {
    const commandID = view()?.pendingCommandID ?? retry?.commandID;
    if (!commandID || !view()?.canManage || busy()) return;
    const epoch = generation;
    setBusy(true);
    setError("");
    try {
      const value = await apiRequest(environmentSettingsView, path(), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandID }),
      });
      if (epoch !== generation) return;
      retry = undefined;
      publish(value);
      setNotice("Pending save discarded. Existing settings are unchanged.");
    } catch {
      if (epoch === generation)
        setError("Could not discard the pending save. Reload to check its result.");
    } finally {
      if (epoch === generation) setBusy(false);
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const current = view();
    if (!editable() || !current) return;
    const epoch = generation;
    const input = retry ?? {
      commandID: crypto.randomUUID(),
      version: current.version,
      variables: variables(),
      registries: registries(),
    };
    retry = input;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await apiRequest(environmentSettingsView, path(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (epoch !== generation) return;
      retry = undefined;
      publish(value);
      setNotice("Saved. New starts use these settings; restart existing compute to apply.");
    } catch (cause) {
      if (epoch === generation) {
        const latest = await apiRequest(environmentSettingsView, path()).catch(() => undefined);
        if (epoch !== generation) return;
        if (latest) {
          setView(latest);
          if (!latest.pending || latest.pendingCommandID !== input.commandID) retry = undefined;
        }
        setError(cause instanceof Error ? cause.message : "Could not save environment");
      }
    } finally {
      if (epoch === generation) setBusy(false);
    }
  }
  function previewPaste() {
    try {
      setPreview(parseEnvironmentPaste(paste()));
      setError("");
    } catch {
      setPreview([]);
      setError("Check the pasted variable names, quotes and duplicate entries.");
    }
  }
  function importPaste() {
    setVariables((items) => {
      const result = [...items];
      for (const entry of preview()) {
        const index = result.findIndex((item) => item.name === entry.name);
        if (index < 0) result.push({ ...entry, runtime: true, build: false, verification: false });
        else {
          const existing = result[index];
          if (existing) result[index] = { ...existing, value: entry.value };
        }
      }
      return result;
    });
    retry = undefined;
    setPaste("");
    setPreview([]);
  }
  createEffect(
    () => [props.projectID, environment()] as const,
    () => {
      const epoch = ++generation;
      setView(undefined);
      setVariables([]);
      setRegistries([]);
      setPaste("");
      setPreview([]);
      setError("");
      setNotice("");
      setBusy(true);
      retry = undefined;
      void apiRequest(environmentSettingsView, path())
        .then((value) => {
          if (epoch === generation) publish(value);
        })
        .catch((cause) => {
          if (epoch === generation)
            setError(cause instanceof Error ? cause.message : "Could not load environment");
        })
        .finally(() => {
          if (epoch === generation) setBusy(false);
        });
      return () => {
        generation += 1;
        retry = undefined;
      };
    },
  );
  return (
    <section class="environment-settings model-settings-body" aria-label="Project environment">
      <nav class="model-scope" aria-label="Environment">
        <For each={["development", "main-preview"] as const}>
          {(item) => (
            <button
              type="button"
              disabled={busy()}
              aria-pressed={environment() === item ? "true" : "false"}
              onClick={() => setEnvironment(item)}
            >
              {item === "development" ? "Development" : "Main-Preview"}
            </button>
          )}
        </For>
      </nav>
      <p class="model-settings-note">
        Separate settings. Values are masked and never inherited between environments.
      </p>
      <Show
        when={view()}
        fallback={
          <p role="status">{busy() ? "Loading environment…" : "Environment unavailable."}</p>
        }
      >
        {(current) => (
          <>
            <Show when={current().preparation}>
              <p class="model-settings-note" role="status">
                {current().preparation === "succeeded"
                  ? "Development image ready for new starts."
                  : current().preparation === "pending" || current().preparation === "running"
                    ? "Preparing the development image. Editing is available independently."
                    : "Using normal Dev Container startup. No compatible prepared image is available."}
              </p>
            </Show>
            <Show when={!current().storeConfigured}>
              <p role="status">
                Connect OpenBao to manage protected values. Existing editing remains available.
              </p>
            </Show>
            <Show when={current().pending || retry}>
              <p role="status">
                A save is unconfirmed. Retry the same save, or discard it to keep existing settings.
              </p>
              <Show when={current().canManage}>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={busy()}
                  onClick={() => void discardPending()}
                >
                  Discard pending save
                </button>
              </Show>
            </Show>
            <form onSubmit={(event) => void save(event)}>
              <fieldset disabled={!editable() || Boolean(retry)}>
                <legend>Variables</legend>
                <For each={variables()} keyed={false}>
                  {(variable, index) => (
                    <div class="environment-row">
                      <label>
                        Name
                        <input
                          aria-label={`Variable ${index + 1} name`}
                          value={variable().name}
                          onInput={(event) =>
                            changeVariable(index, { name: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label>
                        Replace value
                        <textarea
                          rows="1"
                          aria-label={`Value for ${variable().name || "new variable"}`}
                          autocomplete="off"
                          spellcheck={false}
                          placeholder={
                            current().variables.some((item) => item.name === variable().name)
                              ? "Configured · enter to replace"
                              : "Enter value"
                          }
                          value={variable().value ?? ""}
                          onInput={(event) =>
                            changeVariable(index, { value: event.currentTarget.value })
                          }
                        />
                      </label>
                      <div class="environment-grants">
                        <For each={["runtime", "build", "verification"] as const}>
                          {(grant) => (
                            <label>
                              <input
                                type="checkbox"
                                checked={variable()[grant]}
                                onChange={(event) =>
                                  changeVariable(index, { [grant]: event.currentTarget.checked })
                                }
                              />
                              {grant === "runtime"
                                ? "Runtime"
                                : grant === "build"
                                  ? "Image build"
                                  : "Verification"}
                            </label>
                          )}
                        </For>
                      </div>
                      <button
                        type="button"
                        class="quiet-button"
                        aria-label={`Remove ${variable().name || "variable"}`}
                        onClick={() => {
                          retry = undefined;
                          setVariables((items) =>
                            items.filter((_, position) => position !== index),
                          );
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="quiet-button"
                  onClick={() =>
                    setVariables((items) => [
                      ...items,
                      { name: "", value: "", runtime: true, build: false, verification: false },
                    ])
                  }
                >
                  Add variable
                </button>
                <details class="environment-import">
                  <summary>Paste .env</summary>
                  <textarea
                    aria-label="Paste environment variables"
                    rows="4"
                    autocomplete="off"
                    spellcheck={false}
                    value={paste()}
                    onInput={(event) => {
                      setPaste(event.currentTarget.value);
                      setPreview([]);
                    }}
                  />
                  <button type="button" class="quiet-button" onClick={previewPaste}>
                    Preview import
                  </button>
                  <Show when={preview().length > 0}>
                    <p>
                      {preview()
                        .map((item) => item.name)
                        .join(", ")}{" "}
                      · values hidden
                    </p>
                    <button type="button" class="quiet-button" onClick={importPaste}>
                      Apply to draft
                    </button>
                  </Show>
                </details>
              </fieldset>
              <fieldset disabled={!editable() || Boolean(retry)}>
                <legend>Registries</legend>
                <For each={registries()} keyed={false}>
                  {(registry, index) => (
                    <div class="environment-registry">
                      <label>
                        Registry
                        <input
                          aria-label={`Registry ${index + 1} host`}
                          placeholder="registry.example.com"
                          value={registry().host}
                          onInput={(event) =>
                            changeRegistry(index, { host: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label>
                        Username
                        <input
                          value={registry().username}
                          onInput={(event) =>
                            changeRegistry(index, { username: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label>
                        Replace password
                        <input
                          type="password"
                          autocomplete="new-password"
                          placeholder="Enter to replace"
                          value={registry().password ?? ""}
                          onInput={(event) =>
                            changeRegistry(index, { password: event.currentTarget.value })
                          }
                        />
                      </label>
                      <details>
                        <summary>Certificate and Verification access</summary>
                        <label>
                          Registry CA certificate
                          <textarea
                            rows="3"
                            placeholder="PEM certificate · enter to replace"
                            value={registry().certificate ?? ""}
                            onInput={(event) =>
                              changeRegistry(index, { certificate: event.currentTarget.value })
                            }
                          />
                        </label>
                        <label class="environment-check">
                          <input
                            type="checkbox"
                            checked={registry().verification}
                            onChange={(event) =>
                              changeRegistry(index, { verification: event.currentTarget.checked })
                            }
                          />
                          Allow image pulls during Verification
                        </label>
                      </details>
                      <button
                        type="button"
                        class="quiet-button"
                        aria-label={`Remove registry ${registry().host || index + 1}`}
                        onClick={() => {
                          retry = undefined;
                          setRegistries((items) =>
                            items.filter((_, position) => position !== index),
                          );
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="quiet-button"
                  onClick={() =>
                    setRegistries((items) => [
                      ...items,
                      { host: "", username: "", password: "", verification: false },
                    ])
                  }
                >
                  Add registry
                </button>
              </fieldset>
              <p class="model-settings-note">
                Runtime values can be read by your application and its coding agent. Build values
                require repository-owned BuildKit secret mounts from
                /run/factory-build-secrets/NAME. Verification access is opt-in. Never pass protected
                values through build args.
              </p>
              <Show when={current().canManage}>
                <button type="submit" class="primary-button" disabled={!editable()}>
                  {busy() ? "Saving…" : retry ? "Retry save" : "Save environment"}
                </button>
              </Show>
            </form>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert" class="model-settings-error">
          {error()}
        </p>
      </Show>
      <Show when={notice()}>
        <p role="status">{notice()}</p>
      </Show>
    </section>
  );
}
