import { createSignal, For, onSettled, Show } from "solid-js";
import { type UsageRate, usageRate } from "../../../../packages/conversation-domain/src/usage";
import { serverCall } from "../server-functions/result";
import { getContractPrices, saveContractPrices } from "../server-functions/usage";

type ContractPriceRows = Extract<
  Awaited<ReturnType<typeof getContractPrices>>,
  { ok: true }
>["value"]["rates"];
type Tier = UsageRate["tiers"][number];
const emptyTier = (): Tier => ({
  above: 0,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
});
const buckets = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
] as const;

export function ContractPrices() {
  const [rates, setRates] = createSignal<ContractPriceRows>([]);
  const [provider, setProvider] = createSignal("openai"),
    [model, setModel] = createSignal("");
  const [tiers, setTiers] = createSignal<Tier[]>([emptyTier()]);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [notice, setNotice] = createSignal("");
  let disposed = false;
  let retry:
    | { commandID: string; version: number; provider: string; model: string; tiers: Tier[] | null }
    | undefined;
  onSettled(() => {
    void serverCall(getContractPrices({ data: [] }))
      .then((value) => {
        if (!disposed) setRates(value.rates);
      })
      .catch(() => {
        if (!disposed) setError("Contract prices are unavailable.");
      });
    return () => {
      disposed = true;
    };
  });
  const current = () =>
    rates().find((row) => row.provider === provider().trim() && row.model === model().trim());
  function choose(providerID: string, modelID: string) {
    if (busy() || retry) return;
    setProvider(providerID);
    setModel(modelID);
    setTiers(
      rates()
        .find((row) => row.provider === providerID && row.model === modelID)
        ?.rate?.tiers.map((tier) => ({ ...tier })) ?? [emptyTier()],
    );
    setNotice("");
    setError("");
  }
  async function save(restore = false) {
    if (busy() || !model().trim()) return;
    const identity = { provider: provider().trim(), model: model().trim() };
    try {
      if (!retry) {
        if (!restore)
          usageRate.parse({
            ...identity,
            source: "contract",
            fetchedAt: new Date().toISOString(),
            tiers: tiers(),
          });
        retry = {
          commandID: crypto.randomUUID(),
          version: current()?.version ?? 0,
          ...identity,
          tiers: restore ? null : tiers().map((tier) => ({ ...tier })),
        };
      }
      setBusy(true);
      setError("");
      await serverCall(saveContractPrices({ data: [retry] }));
      const value = await serverCall(getContractPrices({ data: [] }));
      if (disposed) return;
      setRates(value.rates);
      retry = undefined;
      setNotice("Saved for future work. Historical estimates stay unchanged.");
    } catch (cause) {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : "Could not save contract prices");
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  return (
    <details class="usage-breakdown">
      <summary>Contract prices</summary>
      <p class="usage-note">
        Provider catalogue prices are automatic. Override negotiated rates in USD per million
        tokens. Empty rates remain unknown; enter 0 only when that bucket is free.
      </p>
      <Show when={rates().length}>
        <div class="usage-price-models">
          <For each={rates()}>
            {(row) => (
              <button
                type="button"
                class="quiet-button"
                disabled={busy() || Boolean(retry)}
                onClick={() => choose(row.provider, row.model)}
              >
                {row.provider} / {row.model}
                {row.rate ? "" : " · catalogue"}
              </button>
            )}
          </For>
        </div>
      </Show>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy() || Boolean(retry)}>
          <legend>Exact provider and model</legend>
          <div class="usage-fields">
            <label>
              Provider
              <input
                value={provider()}
                onInput={(event) => choose(event.currentTarget.value, model())}
              />
            </label>
            <label>
              Model
              <input
                value={model()}
                onInput={(event) => choose(provider(), event.currentTarget.value)}
              />
            </label>
          </div>
          <For each={tiers()}>
            {(tier, index) => (
              <div class="usage-fields">
                <label>
                  {index() === 0 ? "Base context" : "Above context tokens"}
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={tier.above}
                    disabled={index() === 0}
                    onInput={(event) =>
                      setTiers((previous) =>
                        previous.map((value, i) =>
                          i === index()
                            ? { ...value, above: Number(event.currentTarget.value) }
                            : value,
                        ),
                      )
                    }
                  />
                </label>
                <For each={buckets}>
                  {(bucket) => (
                    <label>
                      {bucket.label}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="Unknown"
                        value={tier[bucket.key] ?? ""}
                        onInput={(event) => {
                          const value = event.currentTarget.value;
                          setTiers((previous) =>
                            previous.map((tier, i) =>
                              i === index()
                                ? { ...tier, [bucket.key]: value === "" ? null : Number(value) }
                                : tier,
                            ),
                          );
                        }}
                      />
                    </label>
                  )}
                </For>
                <Show when={index() > 0}>
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() => setTiers((previous) => previous.filter((_, i) => i !== index()))}
                  >
                    Remove context tier
                  </button>
                </Show>
              </div>
            )}
          </For>
          <button
            type="button"
            class="quiet-button"
            disabled={tiers().length >= 8}
            onClick={() =>
              setTiers((previous) => [
                ...previous,
                { ...emptyTier(), above: (previous.at(-1)?.above ?? 0) + 200000 },
              ])
            }
          >
            Add context tier
          </button>
        </fieldset>
        <div class="usage-price-actions">
          <Show when={current()?.rate && !retry}>
            <button
              type="button"
              class="quiet-button"
              disabled={busy()}
              onClick={() => void save(true)}
            >
              Use catalogue prices
            </button>
          </Show>
          <button type="submit" class="primary-button" disabled={busy() || !model().trim()}>
            {busy() ? "Saving…" : retry ? "Retry exact save" : "Save contract prices"}
          </button>
        </div>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <Show when={notice()}>
          <p role="status">{notice()}</p>
        </Show>
      </form>
    </details>
  );
}
