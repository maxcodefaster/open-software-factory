import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { z } from "zod";
import {
  modelConnectionView,
  modelProbeResult,
  modelProvider,
  modelRoleConnectionView,
  type ModelConnectionView,
  type ModelConnectionWrite,
  type ModelProvider,
  type ModelProbeResult,
} from "../../../../packages/conversation-domain/src/model-connection";
import {
  codingReasoningInput,
  type CodingReasoning,
  type ModelSettingsView,
} from "../../../../packages/conversation-domain/src/model-settings";
import { apiRequest, APIRequestError } from "../api-client";
import { reasoningLabels } from "./reasoning";

const catalogue = z.object({
  providers: z.array(
    z.object({
      provider: modelProvider,
      label: z.string(),
      models: z.array(z.string()),
    }),
  ),
  connections: z.array(modelConnectionView),
  roles: z.array(modelRoleConnectionView),
  deployment: z.array(
    z.object({
      role: z.enum(["planning", "build"]),
      provider: modelProvider,
      modelId: z.string(),
      endpoint: z.string().nullable(),
      configured: z.boolean(),
      connectionID: z.uuid(),
    }),
  ),
});
type Catalogue = z.output<typeof catalogue>;
type Role = "planning" | "build";
type RoleSelection = {
  connectionID: string;
  modelId: string;
  reasoningEffort?: CodingReasoning;
};

function connectionLabel(connection: {
  provider: ModelProvider;
  endpoint: string | null;
  connectionID: string;
}) {
  const host = connection.endpoint ? new URL(connection.endpoint).host : connection.provider;
  return `${host.endsWith(".openai.azure.com") ? `Azure · ${host.replace(/\.openai\.azure\.com$/, "")}` : host} · ${connection.connectionID.slice(0, 6)}`;
}

export function ModelConnectionSettings(props: {
  settings: ModelSettingsView;
  disabled: boolean;
  onChange: () => Promise<void>;
  onBusy: (value: boolean) => void;
}) {
  const [data, setData] = createSignal<Catalogue>();
  const [busy, setBusy] = createSignal<Role | "connection">();
  const [error, setError] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [connection, setConnection] = createSignal<ModelConnectionView>();
  const [provider, setProvider] = createSignal<ModelProvider>("openai");
  const [key, setKey] = createSignal("");
  const [endpoint, setEndpoint] = createSignal("");
  const [connectionSaved, setConnectionSaved] = createSignal(false);
  const [resetDrafts, setResetDrafts] = createSignal(0);
  let disposed = false;
  let abort: AbortController | undefined;
  let pendingSave: ModelConnectionWrite | undefined;
  let pendingAdoption: { commandID: string; role: Role; version: number } | undefined;
  let pendingCheck:
    | {
        commandID: string;
        settingsVersion: number;
        connectionID: string;
        version: number;
        role: Role;
        modelId: string;
        reasoningEffort?: CodingReasoning;
        confirmInference: true;
      }
    | undefined;
  const disabled = () => props.disabled || Boolean(busy());
  function working(value: Role | "connection" | undefined) {
    setBusy(value);
    props.onBusy(Boolean(value));
  }
  async function load() {
    const value = await apiRequest(catalogue, "/api/model-connections");
    if (!disposed) setData(value);
  }
  createEffect(
    () => true,
    () => {
      void load().catch((cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not load connections");
      });
    },
  );
  onCleanup(() => {
    disposed = true;
    abort?.abort();
    pendingSave = undefined;
    setKey("");
  });
  function edit(value?: ModelConnectionView) {
    setConnection(value);
    setProvider(value?.provider ?? "openai");
    setEndpoint(value?.endpoint ?? "");
    setKey("");
    setEditing(true);
    setConnectionSaved(false);
    setError("");
    pendingSave = undefined;
  }
  async function saveConnection(event: SubmitEvent) {
    event.preventDefault();
    if (disabled()) return;
    working("connection");
    setError("");
    setConnectionSaved(false);
    try {
      pendingSave ??= {
        commandID: crypto.randomUUID(),
        connectionID: connection()?.connectionID ?? crypto.randomUUID(),
        version: connection()?.version ?? 0,
        provider: provider(),
        endpoint: endpoint().trim() || null,
        apiKey: key(),
      };
      const saved = await apiRequest(
        modelConnectionView,
        `/api/model-connections/${pendingSave.connectionID}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pendingSave),
        },
      );
      if (disposed) return;
      pendingSave = undefined;
      setKey("");
      setConnection(saved);
      await load();
      setEditing(false);
      setConnectionSaved(true);
    } catch (cause) {
      if (!disposed) {
        const pending = pendingSave;
        if (cause instanceof APIRequestError && cause.status === 409 && pending) {
          // Only unlock a rejected form when a read proves this command owns
          // neither a committed version nor the pending external write.
          try {
            const saved = await apiRequest(
              modelConnectionView,
              `/api/model-connections/${pending.connectionID}`,
            );
            if (saved.version === pending.version && saved.pendingCommandID !== pending.commandID)
              pendingSave = undefined;
          } catch (readError) {
            if (readError instanceof APIRequestError && readError.status === 404)
              pendingSave = undefined;
          }
        }
        if (cause instanceof APIRequestError && [400, 403].includes(cause.status))
          pendingSave = undefined;
        setError(cause instanceof Error ? cause.message : "Could not save connection");
      }
    } finally {
      if (!disposed) working(undefined);
    }
  }
  async function selectRole(
    role: Role,
    selection: RoleSelection,
  ): Promise<ModelProbeResult | undefined> {
    if (disabled()) return undefined;
    working(role);
    setError("");
    abort = new AbortController();
    try {
      let selected = data()?.connections.find(
        (entry) => entry.connectionID === selection.connectionID && entry.configured,
      );
      if (!selected) {
        const deployment = data()?.deployment.find(
          (entry) => entry.connectionID === selection.connectionID && entry.configured,
        );
        if (!deployment) throw new Error("Choose a saved connection");
        const adoption = {
          role: deployment.role,
          version:
            data()?.connections.find((entry) => entry.connectionID === deployment.connectionID)
              ?.version ?? 0,
        };
        if (
          !pendingAdoption ||
          pendingAdoption.role !== adoption.role ||
          pendingAdoption.version !== adoption.version
        )
          pendingAdoption = { commandID: crypto.randomUUID(), ...adoption };
        selected = await apiRequest(modelConnectionView, "/api/model-connections/deployment", {
          method: "PUT",
          signal: abort.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pendingAdoption),
        });
        pendingAdoption = undefined;
        const saved = selected;
        if (!disposed)
          setData((previous) =>
            previous
              ? {
                  ...previous,
                  connections: [
                    ...previous.connections.filter(
                      (entry) => entry.connectionID !== saved.connectionID,
                    ),
                    saved,
                  ],
                }
              : previous,
          );
      }
      const request = {
        settingsVersion: props.settings.version,
        connectionID: selected.connectionID,
        version: selected.version,
        role,
        modelId: selection.modelId,
        confirmInference: true as const,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
      const { commandID: _commandID, ...previous } = pendingCheck ?? {};
      if (JSON.stringify(previous) !== JSON.stringify(request))
        pendingCheck = { commandID: crypto.randomUUID(), ...request };
      const result = await apiRequest(modelProbeResult, "/api/model-connections/role", {
        method: "PUT",
        signal: abort.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pendingCheck),
      });
      pendingCheck = undefined;
      if (!disposed) {
        await Promise.all([load(), props.onChange()]);
        return result;
      }
    } catch (cause) {
      if (!disposed)
        setError(
          abort.signal.aborted
            ? "Check stopped. Refresh access status before starting another check."
            : cause instanceof Error
              ? cause.message
              : "Could not check model",
        );
    } finally {
      if (!disposed) working(undefined);
      abort = undefined;
    }
    return undefined;
  }
  return (
    <section class="model-provider-setup" aria-label="Factory models">
      <Show when={data()} fallback={<p role="status">Loading connections…</p>}>
        {(current) => (
          <>
            <div class="model-defaults">
              <For each={["planning", "build"] as const}>
                {(role) => (
                  <ModelRoleSettings
                    role={role}
                    data={current()}
                    settings={props.settings}
                    disabled={disabled()}
                    checking={busy() === role}
                    resetDrafts={resetDrafts()}
                    onSave={(selection) => selectRole(role, selection)}
                    onStop={() => abort?.abort()}
                  />
                )}
              </For>
            </div>
            <p class="model-settings-note model-default-note">
              Defaults apply to new work. Existing Changes keep their model and reasoning. Save
              &amp; check makes a small model call.
            </p>
            <details
              class="model-credentials"
              open={
                editing() ||
                connectionSaved() ||
                !current().connections.some((entry) => entry.configured)
              }
            >
              <summary>
                Connections <span>Keys encrypted in OpenBao</span>
              </summary>
              <section class="model-credentials-body" aria-label="API connections">
                <header>
                  <p class="model-settings-note">
                    Saved keys are never shown here or sent to chat.
                  </p>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={disabled() || Boolean(pendingSave)}
                    onClick={() => edit()}
                  >
                    Add connection
                  </button>
                </header>
                <For each={current().connections.filter((entry) => entry.configured)}>
                  {(entry) => (
                    <div class="model-credential-row">
                      <div>
                        <strong>{connectionLabel(entry)}</strong>
                        <small>Encrypted in OpenBao · v{entry.version}</small>
                      </div>
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={disabled() || Boolean(pendingSave)}
                        aria-label={`Update key for ${connectionLabel(entry)}`}
                        onClick={() => edit(entry)}
                      >
                        Update key
                      </button>
                    </div>
                  )}
                </For>
                <Show when={editing()}>
                  <form
                    class="model-credential-form"
                    onSubmit={(event) => void saveConnection(event)}
                  >
                    <div class="model-role">
                      <label for="connection-provider">Provider</label>
                      <select
                        id="connection-provider"
                        value={provider()}
                        disabled={disabled() || Boolean(connection()) || Boolean(pendingSave)}
                        onChange={(event) =>
                          setProvider(modelProvider.parse(event.currentTarget.value))
                        }
                      >
                        <For each={current().providers}>
                          {(entry) => <option value={entry.provider}>{entry.label}</option>}
                        </For>
                      </select>
                    </div>
                    <div class="model-role">
                      <label for="connection-key">API key</label>
                      <input
                        id="connection-key"
                        type="password"
                        autocomplete="new-password"
                        spellcheck={false}
                        value={key()}
                        disabled={disabled() || Boolean(pendingSave)}
                        placeholder={connection() ? "Enter a replacement key" : "Provider API key"}
                        onInput={(event) => setKey(event.currentTarget.value)}
                      />
                    </div>
                    <details>
                      <summary>Custom endpoint, including Azure</summary>
                      <label for="connection-endpoint">Approved HTTPS endpoint</label>
                      <input
                        id="connection-endpoint"
                        type="url"
                        value={endpoint()}
                        disabled={disabled() || Boolean(pendingSave)}
                        placeholder="Use the provider's default endpoint"
                        onInput={(event) => setEndpoint(event.currentTarget.value)}
                      />
                    </details>
                    <footer class="model-settings-actions">
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={disabled() || Boolean(pendingSave)}
                        onClick={() => {
                          setKey("");
                          setEditing(false);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        class="primary-button"
                        disabled={disabled() || (!key().trim() && !pendingSave)}
                      >
                        {busy() === "connection"
                          ? "Saving…"
                          : pendingSave
                            ? "Retry same save"
                            : "Save connection"}
                      </button>
                    </footer>
                  </form>
                </Show>
                <Show when={connectionSaved()}>
                  <p role="status" class="model-settings-note">
                    Connection encrypted in OpenBao. Choose it above, then save &amp; check a model.
                  </p>
                </Show>
              </section>
            </details>
          </>
        )}
      </Show>
      <Show when={error()}>
        <div class="model-settings-error">
          <p role="alert">{error()}</p>
          <button
            type="button"
            class="quiet-button"
            disabled={disabled()}
            onClick={() => {
              void Promise.all([load(), props.onChange()])
                .then(() => {
                  if (!disposed) {
                    setResetDrafts((value) => value + 1);
                    setError("");
                  }
                })
                .catch(() => {});
            }}
          >
            Reload settings
          </button>
        </div>
      </Show>
    </section>
  );
}

function ModelRoleSettings(props: {
  role: Role;
  data: Catalogue;
  settings: ModelSettingsView;
  disabled: boolean;
  checking: boolean;
  resetDrafts: number;
  onSave: (selection: RoleSelection) => Promise<ModelProbeResult | undefined>;
  onStop: () => void;
}) {
  const [connectionID, setConnectionID] = createSignal("");
  const [model, setModel] = createSignal("");
  const [custom, setCustom] = createSignal(false);
  const [reasoning, setReasoning] = createSignal<CodingReasoning>("medium");
  const [dirty, setDirty] = createSignal(false);
  const [result, setResult] = createSignal<ModelProbeResult>();
  let lastReset = props.resetDrafts;
  const label = () => (props.role === "build" ? "Coding" : "Planning & knowledge");
  const active = () => props.data.roles.find((entry) => entry.role === props.role);
  const deployment = () =>
    props.data.deployment.find((entry) => entry.role === props.role && entry.configured);
  const connection = () =>
    props.data.connections.find((entry) => entry.connectionID === connectionID()) ??
    props.data.deployment.find(
      (entry) => entry.connectionID === connectionID() && entry.configured,
    );
  const connectionSummary = () => {
    const value = connection();
    return value ? `Via ${connectionLabel(value)}` : "Choose a connection";
  };
  const models = () => [
    ...new Set([
      ...(model() ? [model()] : []),
      ...(active()?.active?.modelId &&
      props.data.connections.find((entry) => entry.connectionID === active()?.active?.connectionID)
        ?.provider === connection()?.provider
        ? [active()?.active?.modelId ?? ""]
        : []),
      ...(deployment()?.modelId && deployment()?.provider === connection()?.provider
        ? [deployment()?.modelId ?? ""]
        : []),
      ...(props.data.providers.find((entry) => entry.provider === connection()?.provider)?.models ??
        []),
    ]),
  ];
  createEffect(
    () => ({
      data: props.data,
      settings: props.settings,
      reset: props.resetDrafts,
      role: props.role,
    }),
    ({ data, settings, reset, role: roleName }) => {
      if (dirty() && lastReset === reset) return;
      lastReset = reset;
      setDirty(false);
      const role = data.roles.find((entry) => entry.role === roleName)?.active;
      const environment = data.deployment.find(
        (entry) => entry.role === roleName && entry.configured,
      );
      const available = data.connections.filter((entry) => entry.configured);
      setConnectionID(
        role?.connectionID ??
          environment?.connectionID ??
          (available.length === 1 ? available[0]?.connectionID : undefined) ??
          "",
      );
      setModel(role?.modelId ?? environment?.modelId ?? "");
      setReasoning(settings.rules.build.reasoningEffort);
      setCustom(false);
    },
  );
  function changed() {
    setDirty(true);
    setResult(undefined);
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const checked = await props.onSave({
      connectionID: connectionID(),
      modelId: model().trim(),
      ...(props.role === "build" && connection()?.provider === "openai"
        ? { reasoningEffort: reasoning() }
        : {}),
    });
    if (checked) {
      setResult(checked);
      if (checked.status === "ready") {
        setDirty(false);
        setCustom(false);
        setModel(checked.modelId);
      }
    }
  }
  const accessStatus = () => {
    if (props.checking) return "Checking access…";
    const check = active()?.check;
    if (check?.state === "probing") return "Access check in progress";
    if (check?.state === "uncertain") return "Last check interrupted. Nothing was resent.";
    if (check?.result && check.result.status !== "ready")
      return `Last check: ${check.result.status.replaceAll("-", " ")}`;
    if (check?.result?.status === "ready") return "Access checked";
    return active()?.active || deployment() ? "Access not checked" : "Not configured";
  };
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
              value={custom() ? "__custom" : model()}
              disabled={props.disabled || !connection()}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setCustom(value === "__custom");
                setModel(value === "__custom" ? "" : value);
                changed();
              }}
            >
              <option value="">Choose a model</option>
              <For each={models()}>
                {(id) => (
                  <option value={id} selected={!custom() && model() === id}>
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
                value={reasoning()}
                disabled={props.disabled}
                onChange={(event) => {
                  setReasoning(codingReasoningInput.parse(event.currentTarget.value));
                  changed();
                }}
              >
                <For each={codingReasoningInput.options}>
                  {(value) => <option value={value}>{reasoningLabels[value]}</option>}
                </For>
              </select>
            </div>
          </Show>
        </div>
        <Show when={custom()}>
          <div class="model-role">
            <label for={`${props.role}-custom-model`}>Model or deployment ID</label>
            <input
              id={`${props.role}-custom-model`}
              value={model()}
              disabled={props.disabled}
              required
              placeholder="Exact provider model or Azure deployment ID"
              onInput={(event) => {
                setModel(event.currentTarget.value);
                changed();
              }}
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
                value={connectionID()}
                disabled={props.disabled}
                onChange={(event) => {
                  setConnectionID(event.currentTarget.value);
                  setModel("");
                  setCustom(false);
                  changed();
                }}
              >
                <option value="" selected={!connectionID()}>
                  Choose a connection
                </option>
                <For each={props.data.connections.filter((entry) => entry.configured)}>
                  {(entry) => (
                    <option
                      value={entry.connectionID}
                      selected={entry.connectionID === connectionID()}
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
                      selected={entry.connectionID === connectionID()}
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
              disabled={props.disabled || !connection() || !model().trim()}
            >
              {props.checking ? "Checking…" : "Save & check"}
            </button>
          </div>
        </footer>
        <Show when={result()}>
          {(checked) => (
            <p role="status" class="model-settings-note">
              {checked().status === "ready"
                ? "Model saved. Access checked."
                : `Not saved: ${checked().status.replaceAll("-", " ")}. Previous settings remain active.`}
            </p>
          )}
        </Show>
      </form>
    </section>
  );
}
