import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type {
  ModelConnectionView,
  ModelConnectionWrite,
  ModelProbeResult,
  ModelProvider,
} from "#conversation-domain/model-connection";
import type { ModelSettingsView } from "#conversation-domain/model-settings";
import { APIRequestError } from "../api-client";
import { plainErrorMessage } from "../command-error";
import {
  adoptDeploymentModelConnection,
  getModelConnection,
  getModelConnections,
  saveModelConnection,
  selectModelRole,
} from "../server-functions/models";
import { serverCall } from "../server-functions/result";
import { ModelConnectionCredentials } from "./connection-credentials";
import {
  type Catalogue,
  type ConnectionFormState,
  isProbingRole,
  type ModelRole,
  type PendingAdoption,
  type PendingCheck,
  type ProbeActivity,
  type RoleSelection,
  startEditingConnection,
} from "./connection-state";
import { ModelRoleSettingsCard } from "./role-settings-card";

async function shouldUnlockFailedSave(
  cause: unknown,
  pending: ModelConnectionWrite,
): Promise<boolean> {
  if (cause instanceof APIRequestError && [400, 403].includes(cause.status)) return true;
  if (!(cause instanceof APIRequestError && cause.status === 409)) return false;
  // Only unlock a rejected form when a read proves this command owns
  // neither a committed version nor the pending external write.
  try {
    const saved = await serverCall(getModelConnection({ data: [pending.connectionID] }));
    return saved.version === pending.version && saved.pendingCommandID !== pending.commandID;
  } catch (readError) {
    return readError instanceof APIRequestError && readError.status === 404;
  }
}

export function ModelConnectionSettings(props: {
  settings: ModelSettingsView;
  disabled: boolean;
  onChange: () => Promise<void>;
  onBusy: (value: boolean) => void;
}) {
  const [data, setData] = createSignal<Catalogue>();
  const [form, setForm] = createSignal<ConnectionFormState>({ kind: "viewing", saved: false });
  const [probe, setProbe] = createSignal<ProbeActivity>({ kind: "idle" });
  const [error, setError] = createSignal("");
  const [resetDrafts, setResetDrafts] = createSignal(0);
  let disposed = false;

  const isBusy = () => form().kind === "saving" || probe().kind === "probing";
  const disabled = () => props.disabled || isBusy();

  function updateForm(next: ConnectionFormState) {
    setForm(next);
    props.onBusy(next.kind === "saving" || probe().kind === "probing");
  }
  function updateProbe(next: ProbeActivity) {
    setProbe(next);
    props.onBusy(form().kind === "saving" || next.kind === "probing");
  }
  function patchEditingForm(
    patch: Partial<{ provider: ModelProvider; apiKey: string; endpoint: string }>,
  ) {
    setForm((current) => (current.kind === "editing" ? { ...current, ...patch } : current));
  }

  async function load() {
    const value = await serverCall(getModelConnections({ data: [] }));
    if (!disposed) setData(value);
  }

  createEffect(
    () => true,
    () => {
      void load().catch((cause: unknown) => {
        if (!disposed)
          setError(
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "Could not load connections",
          );
      });
    },
  );

  onCleanup(() => {
    disposed = true;
    const currentProbe = probe();
    if (currentProbe.kind === "probing") currentProbe.abort.abort();
    setForm({ kind: "viewing", saved: false });
  });

  function beginEdit(target?: ModelConnectionView) {
    setForm(startEditingConnection(target));
    setError("");
  }

  async function saveConnection(event: SubmitEvent) {
    event.preventDefault();
    const current = form();
    if (disabled() || current.kind !== "editing") return;
    const write: ModelConnectionWrite = current.pendingSave ?? {
      commandID: crypto.randomUUID(),
      connectionID: current.target?.connectionID ?? crypto.randomUUID(),
      version: current.target?.version ?? 0,
      provider: current.provider,
      endpoint: current.endpoint.trim() || null,
      apiKey: current.apiKey,
    };
    setError("");
    updateForm({
      kind: "saving",
      target: current.target,
      provider: current.provider,
      apiKey: current.apiKey,
      endpoint: current.endpoint,
      pendingSave: write,
    });
    try {
      await serverCall(saveModelConnection({ data: [write] }));
      if (disposed) return;
      await load();
      if (disposed) return;
      updateForm({ kind: "viewing", saved: true });
    } catch (cause) {
      if (disposed) return;
      const unlock = await shouldUnlockFailedSave(cause, write);
      if (disposed) return;
      setError(
        cause instanceof Error ? plainErrorMessage(cause.message) : "Could not save connection",
      );
      updateForm({
        kind: "editing",
        target: current.target,
        provider: current.provider,
        apiKey: current.apiKey,
        endpoint: current.endpoint,
        pendingSave: unlock ? undefined : write,
      });
    }
  }

  async function selectRole(
    role: ModelRole,
    selection: RoleSelection,
  ): Promise<ModelProbeResult | undefined> {
    if (disabled()) return undefined;
    setError("");
    const abort = new AbortController();
    let pendingAdoption: PendingAdoption | undefined = probe().pendingAdoption;
    let pendingCheck: PendingCheck | undefined = probe().pendingCheck;
    updateProbe({ kind: "probing", role, abort, pendingAdoption, pendingCheck });
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
        selected = await serverCall(
          adoptDeploymentModelConnection({ ...{ signal: abort.signal }, data: [pendingAdoption] }),
        );
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
      if (!pendingCheck || JSON.stringify(previous) !== JSON.stringify(request))
        pendingCheck = { commandID: crypto.randomUUID(), ...request };
      const result = await serverCall(
        selectModelRole({ ...{ signal: abort.signal }, data: [pendingCheck] }),
      );
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
              ? plainErrorMessage(cause.message)
              : "Could not check model",
        );
    } finally {
      if (!disposed) updateProbe({ kind: "idle", pendingAdoption, pendingCheck });
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
                  <ModelRoleSettingsCard
                    role={role}
                    data={current()}
                    settings={props.settings}
                    disabled={disabled()}
                    checking={isProbingRole(probe(), role)}
                    resetDrafts={resetDrafts()}
                    onSave={(selection) => selectRole(role, selection)}
                    onStop={() => {
                      const currentProbe = probe();
                      if (currentProbe.kind === "probing") currentProbe.abort.abort();
                    }}
                  />
                )}
              </For>
            </div>
            <p class="model-settings-note model-default-note">
              Defaults apply to new work. Existing Changes keep their model and reasoning. Save
              &amp; check makes a small model call.
            </p>
            <ModelConnectionCredentials
              data={current()}
              form={form()}
              disabled={disabled()}
              onAdd={() => beginEdit()}
              onEdit={(entry) => beginEdit(entry)}
              onCancel={() => setForm({ kind: "viewing", saved: false })}
              onProviderChange={(provider) => patchEditingForm({ provider })}
              onKeyChange={(apiKey) => patchEditingForm({ apiKey })}
              onEndpointChange={(endpoint) => patchEditingForm({ endpoint })}
              onSubmit={(event) => void saveConnection(event)}
            />
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
