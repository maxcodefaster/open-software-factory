import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import {
  executionPolicy,
  type ExecutionPolicy,
} from "../../../../packages/conversation-domain/src/execution-policy";
import {
  type UsageSettingsView,
  type currentComputeView,
} from "../../../../packages/conversation-domain/src/usage-view";
import { serverCall } from "../server-functions/result";
import { getUsage, getCurrentCompute, saveUsage } from "../server-functions/usage";
import "./settings.css";
import { ContractPrices } from "./contract-prices";

const fields = [
  { key: "codingUSD", label: "Monthly Coding allowance", unit: "USD", step: "0.01" },
  { key: "sandboxes", label: "Execution Sandboxes", unit: "simultaneous", step: "1" },
  { key: "cpuMilli", label: "Reserved CPU", unit: "millicores", step: "1" },
  { key: "memoryMiB", label: "Reserved memory", unit: "MiB", step: "1" },
] as const;
const usd = (nano: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(Number(nano) / 1_000_000_000);
const tokens = (count: string) => new Intl.NumberFormat("en-US").format(Number(count));

export function UsageSettings(props: { projectID?: string | undefined }) {
  const [view, setView] = createSignal<UsageSettingsView>();
  const [compute, setCompute] = createSignal<ReturnType<typeof currentComputeView.parse>>();
  const [policy, setPolicy] = createSignal<ExecutionPolicy>(executionPolicy.parse({}));
  const [timezone, setTimezone] = createSignal("UTC");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  let epoch = 0;
  let retry:
    | { commandID: string; version: number; policy: ExecutionPolicy; timezone?: string }
    | undefined;
  const scope = () => props.projectID ?? null;
  const usageRead = createMemo(() => {
    const target = scope();
    return serverCall(getUsage(target)).then(
      (value) => ({ target, ok: true as const, value }),
      (cause: unknown) => ({
        target,
        ok: false as const,
        message: cause instanceof Error ? cause.message : "Usage is unavailable",
      }),
    );
  });
  function publish(value: UsageSettingsView) {
    setView(value);
    setPolicy(
      props.projectID
        ? (value.project ?? executionPolicy.parse({ finishPercent: value.factory.finishPercent }))
        : value.factory,
    );
    setTimezone(value.timezone);
  }
  createEffect(scope, (target) => {
    const current = ++epoch;
    let disposed = false;
    setView(undefined);
    setCompute(undefined);
    setError("");
    setNotice("");
    retry = undefined;
    setBusy(false);
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const value = await serverCall(getCurrentCompute(target));
        if (!disposed && current === epoch) setCompute(value);
      } catch {
        if (!disposed && current === epoch) setCompute(undefined);
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const refreshTimer = setInterval(() => void refresh(), 15000);
    return () => {
      disposed = true;
      clearInterval(refreshTimer);
    };
  });
  createEffect(usageRead, (result) => {
    if (result.target !== scope()) return;
    if (result.ok) publish(result.value);
    else setError(result.message);
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const current = view();
    if (!current?.canEdit || busy()) return;
    const generation = epoch;
    retry ??= {
      commandID: crypto.randomUUID(),
      version: current.version,
      policy: policy(),
      ...(!props.projectID ? { timezone: timezone() } : {}),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await serverCall(saveUsage(scope(), retry));
      const value = await serverCall(getUsage(scope()));
      if (generation !== epoch) return;
      retry = undefined;
      publish(value);
      setNotice("Saved. Existing work is retained.");
    } catch (cause) {
      if (generation === epoch)
        setError(cause instanceof Error ? cause.message : "Could not save Usage & limits");
    } finally {
      if (generation === epoch) setBusy(false);
    }
  }
  const coding = () => view()?.scopes.find((scope) => scope.scope === (props.projectID ?? null));
  return (
    <section class="usage-settings" aria-label="Usage & limits">
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={view()} fallback={<p role="status">Loading usage…</p>}>
        {(value) => (
          <>
            <p class="usage-note">
              This calendar month · {value().timezone}. Estimates use observed consumption and the
              rate saved for each operation.
            </p>
            <div class="usage-totals">
              <section>
                <span>Coding</span>
                <strong>{usd(coding()?.knownNanoUSD ?? "0")}</strong>
                <small>
                  {coding()?.warning
                    ? "Allowance needs attention"
                    : "Measured separately from Project-agent work"}
                </small>
              </section>
              <section>
                <span>Project agent</span>
                <strong>{usd(value().projectAgentTotal.knownNanoUSD)}</strong>
                <small>Research, Requirements, Wiki and setup</small>
              </section>
            </div>
            <Show
              when={
                value().summary.some((row) => row.incomplete) ||
                coding()?.incomplete ||
                value().projectAgentTotal.incomplete
              }
            >
              <p class="usage-note" role="status">
                Partial estimate. Missing counters or prices are unknown, not free usage.
              </p>
            </Show>
            <Show when={!value().allowed}>
              <p role="status">
                {value().reason === "accounting-incomplete"
                  ? "New Coding work waits for complete accounting."
                  : "The Coding start allowance is used. Existing work has its finish reserve."}
              </p>
            </Show>
            <Show when={value().effective.codingUSD !== null}>
              <p class="usage-note">
                New Coding starts stop at{" "}
                {usd(String(Math.round((value().effective.codingUSD ?? 0) * 1e9)))}. Already
                commissioned work shares a {value().effective.finishPercent}% finish reserve.
                In-flight calls finish and may exceed the estimate. Resets{" "}
                {coding()?.reset
                  ? new Date(coding()?.reset ?? "").toLocaleDateString()
                  : "at the next calendar month"}
                .
              </p>
            </Show>
            <Show when={value().summary.length}>
              <details class="usage-breakdown">
                <summary>
                  {value().detailScope === "own" ? "Your model usage" : "Model usage"}
                </summary>
                <div class="usage-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Work</th>
                        <th>Input / output</th>
                        <th>Estimate</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={value().summary}>
                        {(row) => (
                          <tr>
                            <td>
                              {row.model}
                              <small>{row.provider}</small>
                            </td>
                            <td>{row.purpose}</td>
                            <td>
                              {tokens(row.input)} / {tokens(row.output)}
                              <small>
                                Cache {tokens(row.cacheRead)} read · {tokens(row.cacheWrite)} write
                              </small>
                            </td>
                            <td>
                              {usd(row.knownNanoUSD)}
                              {row.incomplete ? " + unknown" : ""}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </details>
            </Show>
            <section>
              <h3>Compute allocation</h3>
              <p class="usage-note">
                {value().allocation.sandboxes} execution Sandboxes · {value().allocation.cpuMilli}{" "}
                millicores · {value().allocation.memoryMiB} MiB reserved. Includes preparation and
                pending cleanup.
              </p>
              <Show
                when={compute()}
                fallback={<p class="usage-note">Current CPU and memory are unavailable.</p>}
              >
                {(current) => (
                  <>
                    <Show
                      when={current().observations.length}
                      fallback={<p class="usage-note">No execution Sandboxes are running.</p>}
                    >
                      <ul class="usage-observations">
                        <For each={current().observations}>
                          {(observation) => (
                            <li>
                              <span>{observation.kind}</span>
                              <span>
                                {observation.status === "available" ||
                                observation.status === "stale"
                                  ? `${Math.round(observation.cpuMilli ?? 0)} millicores · ${Math.round(observation.memoryMiB ?? 0)} MiB`
                                  : "Current usage unavailable"}
                              </span>
                              <small>
                                {observation.timestamp
                                  ? `${observation.status === "stale" ? "Stale · " : ""}${new Date(observation.timestamp).toLocaleTimeString()}`
                                  : observation.status === "forbidden"
                                    ? "Cluster access denied"
                                    : "No current observation"}{" "}
                                · Running since{" "}
                                {new Date(observation.startedAt).toLocaleTimeString()}
                              </small>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={current().hasMore}>
                      <p class="usage-note">Showing the first sixteen current Sandboxes.</p>
                    </Show>
                  </>
                )}
              </Show>
            </section>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(event);
              }}
            >
              <fieldset disabled={!value().canEdit || busy() || Boolean(retry)}>
                <legend>Optional limits</legend>
                <p class="usage-note">
                  Empty values leave limits disabled
                  {props.projectID ? " or inherited from Factory" : ""}. Lowering limits never
                  removes allocated work. CPU and memory apply to reservations, not momentary load.
                </p>
                <div class="usage-fields">
                  <For each={fields}>
                    {(field) => (
                      <label>
                        {field.label}
                        <div>
                          <input
                            type="number"
                            min="0"
                            step={field.step}
                            value={policy()[field.key] ?? ""}
                            placeholder={props.projectID ? "Inherit" : "Disabled"}
                            onInput={(event) =>
                              setPolicy((previous) => ({
                                ...previous,
                                [field.key]:
                                  event.currentTarget.value === ""
                                    ? null
                                    : Number(event.currentTarget.value),
                              }))
                            }
                          />
                          <small>{field.unit}</small>
                        </div>
                        <Show when={props.projectID && value().effective[field.key] !== null}>
                          <small>
                            Effective: {value().effective[field.key]} {field.unit}
                          </small>
                        </Show>
                      </label>
                    )}
                  </For>
                  <label>
                    Finish reserve
                    <div>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={policy().finishPercent}
                        onInput={(event) =>
                          setPolicy((previous) => ({
                            ...previous,
                            finishPercent: Number(event.currentTarget.value),
                          }))
                        }
                      />
                      <small>%</small>
                    </div>
                  </label>
                  <Show when={!props.projectID}>
                    <label>
                      Installation timezone
                      <input
                        value={timezone()}
                        onInput={(event) => setTimezone(event.currentTarget.value)}
                      />
                    </label>
                  </Show>
                </div>
              </fieldset>
              <Show when={value().canEdit}>
                <button type="submit" class="primary-button" disabled={busy()}>
                  {busy() ? "Saving…" : retry ? "Retry exact save" : "Save limits"}
                </button>
              </Show>
              <Show when={notice()}>
                <p role="status">{notice()}</p>
              </Show>
            </form>
            <Show when={!props.projectID}>
              <ContractPrices />
            </Show>
            <p class="usage-note">
              Start thresholds are estimates, not invoice caps. Limits do not stop IDE access or
              ongoing calls. Usage details are retained for twelve months. No prompts or responses
              are included.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
