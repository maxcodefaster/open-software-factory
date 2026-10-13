import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { z } from "zod";
import {
  modelConnectionView,
  modelProbeResult,
  modelProvider,
  modelRoleConnectionView,
  type ModelConnectionView,
  type ModelProvider,
} from "../../../../packages/conversation-domain/src/model-connection";
import { apiRequest } from "../api-client";

const catalogue = z.object({
  providers: z.array(
    z.object({ provider: modelProvider, label: z.string(), models: z.array(z.string()) }),
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

export function ModelConnectionSettings(props: { onChange: () => void; settingsVersion: number }) {
  const [data, setData] = createSignal<z.output<typeof catalogue>>();
  const [provider, setProvider] = createSignal<ModelProvider>("openai");
  const [key, setKey] = createSignal("");
  const [endpoint, setEndpoint] = createSignal("");
  const [connection, setConnection] = createSignal<ModelConnectionView>();
  const [role, setRole] = createSignal<"planning" | "build">("planning");
  const [model, setModel] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [result, setResult] = createSignal<z.output<typeof modelProbeResult>>();
  const [useDeployment, setUseDeployment] = createSignal(false);
  let adoption: { commandID: string; role: "planning" | "build"; version: number } | undefined;
  let pending:
    | {
        commandID: string;
        connectionID: string;
        version: number;
        provider: ModelProvider;
        endpoint: string | null;
        apiKey: string;
      }
    | undefined;
  let abort: AbortController | undefined;
  let probeCommand:
    | {
        commandID: string;
        settingsVersion: number;
        connectionID: string;
        version: number;
        role: "planning" | "build";
        modelId: string;
        confirmInference: true;
      }
    | undefined;
  let disposed = false;
  const models = () =>
    data()?.providers.find((entry) => entry.provider === provider())?.models ?? [];
  const deployment = () =>
    data()?.deployment.find((entry) => entry.role === role() && entry.configured);
  async function load() {
    try {
      const value = await apiRequest(catalogue, "/api/model-connections");
      if (!disposed) setData(value);
    } catch (cause) {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : "Could not load model connections");
    }
  }
  createEffect(
    () => true,
    () => {
      void load();
    },
  );
  onCleanup(() => {
    disposed = true;
    abort?.abort();
    pending = undefined;
    adoption = undefined;
    setKey("");
  });
  function chooseProvider(value: ModelProvider) {
    setProvider(value);
    setConnection(undefined);
    setModel("");
    setResult(undefined);
    setEndpoint("");
    setKey("");
    pending = undefined;
    probeCommand = undefined;
    setUseDeployment(false);
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || !model()) return;
    setBusy(true);
    setError("");
    setResult(undefined);
    abort = new AbortController();
    try {
      let selected = connection();
      if (useDeployment() && selected?.connectionID !== deployment()?.connectionID) {
        const defaults = deployment();
        if (!defaults) throw new Error("Deployment connection is unavailable");
        adoption ??= {
          commandID: crypto.randomUUID(),
          role: role(),
          version:
            data()?.connections.find((value) => value.connectionID === defaults.connectionID)
              ?.version ?? 0,
        };
        selected = await apiRequest(modelConnectionView, "/api/model-connections/deployment", {
          method: "PUT",
          signal: abort.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(adoption),
        });
        adoption = undefined;
        if (!disposed) setConnection(selected);
      }
      if (key() || pending) {
        pending ??= {
          commandID: crypto.randomUUID(),
          connectionID: selected?.connectionID ?? crypto.randomUUID(),
          version: selected?.version ?? 0,
          provider: provider(),
          endpoint: endpoint().trim() || null,
          apiKey: key(),
        };
        selected = await apiRequest(
          modelConnectionView,
          `/api/model-connections/${pending.connectionID}`,
          {
            method: "PUT",
            signal: abort.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(pending),
          },
        );
        pending = undefined;
        setKey("");
        if (!disposed) setConnection(selected);
      }
      if (!selected?.configured)
        throw new Error("Enter a provider key or select an existing connection");
      probeCommand ??= {
        commandID: crypto.randomUUID(),
        settingsVersion: props.settingsVersion,
        connectionID: selected.connectionID,
        version: selected.version,
        role: role(),
        modelId: model(),
        confirmInference: true,
      };
      const checked = await apiRequest(modelProbeResult, "/api/model-connections/role", {
        method: "PUT",
        signal: abort.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(probeCommand),
      });
      probeCommand = undefined;
      if (!disposed) {
        setResult(checked);
        props.onChange();
        void load();
      }
    } catch (cause) {
      if (!disposed && !abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not save model connection");
    } finally {
      if (!disposed) setBusy(false);
      abort = undefined;
    }
  }
  return (
    <section class="model-provider-setup" aria-label="Provider connections">
      <h3>Model connections</h3>
      <p class="model-settings-note">
        Keys stay encrypted in OpenBao. Research, requirements and Wiki share one model;
        implementation can use a different provider.
      </p>
      <section class="model-connection-status" aria-label="Role access">
        <For each={data()?.roles ?? []}>
          {(entry) => (
            <div>
              <strong>
                {entry.role === "planning" ? "Project agent & Wiki" : "Implementation"}
              </strong>
              <span>
                {entry.active?.modelId ??
                  data()?.deployment.find(
                    (configured) => configured.role === entry.role && configured.configured,
                  )?.modelId ??
                  "Not configured"}
              </span>
              <small>
                {entry.check?.state === "probing"
                  ? "Checking access…"
                  : entry.check?.state === "uncertain"
                    ? "Last check interrupted. No request was resent."
                    : entry.check?.result?.status === "ready"
                      ? "Access checked"
                      : entry.check?.result
                        ? `Last check: ${entry.check.result.status.replaceAll("-", " ")}`
                        : "Access not checked"}
              </small>
            </div>
          )}
        </For>
      </section>
      <form onSubmit={(event) => void save(event)}>
        <div class="model-role">
          <label for="connection-role">Used for</label>
          <select
            id="connection-role"
            value={role()}
            disabled={busy()}
            onChange={(event) => {
              setRole(event.currentTarget.value as "planning" | "build");
              setResult(undefined);
              setUseDeployment(false);
              probeCommand = undefined;
            }}
          >
            <option value="planning">Research, requirements &amp; Wiki</option>
            <option value="build">Implementation</option>
          </select>
        </div>
        <Show when={deployment()}>
          {(configured) => (
            <label class="model-checkbox model-deployment-choice">
              <input
                type="checkbox"
                checked={useDeployment()}
                disabled={busy()}
                onChange={(event) => {
                  const chosen = event.currentTarget.checked;
                  setUseDeployment(chosen);
                  if (chosen) {
                    setProvider(configured().provider);
                    setModel(configured().modelId);
                    setKey("");
                    setEndpoint(configured().endpoint ?? "");
                    setConnection(
                      data()?.connections.find(
                        (entry) =>
                          entry.connectionID === configured().connectionID && entry.configured,
                      ),
                    );
                  }
                  setResult(undefined);
                  probeCommand = undefined;
                }}
              />{" "}
              Use deployment connection · {configured().modelId}
            </label>
          )}
        </Show>
        <div class="model-role">
          <label for="connection-provider">Provider</label>
          <select
            id="connection-provider"
            value={provider()}
            disabled={busy() || useDeployment()}
            onChange={(event) => chooseProvider(modelProvider.parse(event.currentTarget.value))}
          >
            <For each={data()?.providers ?? []}>
              {(entry) => <option value={entry.provider}>{entry.label}</option>}
            </For>
          </select>
        </div>
        <Show
          when={data()?.connections.some(
            (entry) => entry.provider === provider() && entry.configured,
          )}
        >
          <div class="model-role">
            <label for="existing-connection">Connection</label>
            <select
              id="existing-connection"
              value={connection()?.connectionID ?? ""}
              disabled={busy() || useDeployment()}
              onChange={(event) => {
                const selected = data()?.connections.find(
                  (entry) => entry.connectionID === event.currentTarget.value,
                );
                setConnection(selected);
                setEndpoint(selected?.endpoint ?? "");
                setKey("");
                pending = undefined;
                probeCommand = undefined;
              }}
            >
              <option value="">New connection</option>
              <For
                each={
                  data()?.connections.filter(
                    (entry) => entry.provider === provider() && entry.configured,
                  ) ?? []
                }
              >
                {(entry) => (
                  <option value={entry.connectionID}>
                    {entry.endpoint ? new URL(entry.endpoint).host : "Configured provider"}
                  </option>
                )}
              </For>
            </select>
          </div>
        </Show>
        <div class="model-role">
          <label for="connection-key">API key</label>
          <input
            id="connection-key"
            type="password"
            autocomplete="new-password"
            spellcheck={false}
            value={key()}
            disabled={busy() || Boolean(pending) || useDeployment()}
            placeholder={
              connection()?.configured ? "Stored securely. Leave blank to keep." : "Provider key"
            }
            onInput={(event) => setKey(event.currentTarget.value)}
          />
        </div>
        <details>
          <summary>Enterprise endpoint</summary>
          <label for="connection-endpoint">HTTPS endpoint approved by your deployment</label>
          <input
            id="connection-endpoint"
            type="url"
            value={endpoint()}
            disabled={busy() || Boolean(pending) || useDeployment()}
            placeholder="Use native provider endpoint"
            onInput={(event) => setEndpoint(event.currentTarget.value)}
          />
        </details>
        <div class="model-role">
          <label for="connection-model">Model</label>
          <input
            id="connection-model"
            list="connection-models"
            value={model()}
            disabled={busy() || useDeployment()}
            placeholder="Select or enter your provider model"
            onInput={(event) => {
              setModel(event.currentTarget.value);
              setResult(undefined);
              probeCommand = undefined;
            }}
          />
          <datalist id="connection-models">
            <For each={models()}>{(id) => <option value={id} />}</For>
          </datalist>
        </div>
        <p class="model-settings-note">
          Save performs a small inference check with tools and structured output. Provider usage
          charges may apply. Limits are shown only when reported; this is not a throughput
          benchmark.
        </p>
        <footer class="model-settings-actions">
          <Show when={busy()}>
            <button type="button" class="quiet-button" onClick={() => abort?.abort()}>
              Stop check
            </button>
          </Show>
          <button
            type="submit"
            disabled={
              busy() ||
              !model() ||
              (!key() && !connection()?.configured && !pending && !useDeployment())
            }
          >
            {busy() ? "Checking connection…" : "Save and check"}
          </button>
        </footer>
      </form>
      <Show when={result()}>
        {(checked) => (
          <p class="model-settings-note" role="status">
            {checked().status === "ready"
              ? "Model ready for new work."
              : `Connection check: ${checked().status.replaceAll("-", " ")}. Existing settings remain active.`}{" "}
            {checked().limits.tokens === null
              ? "Token limit not reported."
              : `Provider token limit: ${checked().limits.tokens}.`}
            {checked().limits.requests !== null
              ? ` Provider request limit: ${checked().limits.requests}.`
              : " Request limit not reported."}
          </p>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert" class="model-settings-error">
          {error()}
        </p>
      </Show>
    </section>
  );
}
