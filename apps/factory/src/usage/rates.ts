import { z } from "zod";
import { type UsageRate, usageRate } from "../../../../packages/conversation-domain/src/usage";

const cost = z.number().finite().nonnegative().max(1_000_000).optional();
const prices = z.object({ input: cost, output: cost, cache_read: cost, cache_write: cost });
const model = z.object({
  cost: prices.extend({ context_over_200k: prices.optional() }).optional(),
});
const provider = z.object({ models: z.record(z.string(), model) });
const catalogue = z.record(z.string(), provider);
export function catalogueRate(
  input: unknown,
  providerID: string,
  modelID: string,
  fetchedAt: string,
): UsageRate | null {
  const parsed = catalogue.safeParse(input);
  if (!parsed.success) return null;
  return parsedRate(parsed.data, providerID, modelID, fetchedAt);
}
function parsedRate(
  input: z.infer<typeof catalogue>,
  providerID: string,
  modelID: string,
  fetchedAt: string,
): UsageRate | null {
  const selected = input[providerID]?.models[modelID]?.cost;
  if (!selected) return null;
  const tier = (value: z.infer<typeof prices>, above: number) => ({
    above,
    input: value.input ?? null,
    output: value.output ?? null,
    cacheRead: value.cache_read ?? null,
    cacheWrite: value.cache_write ?? null,
  });
  return usageRate.parse({
    provider: providerID,
    model: modelID,
    source: "catalogue",
    fetchedAt,
    tiers: [
      tier(selected, 0),
      ...(selected.context_over_200k ? [tier(selected.context_over_200k, 200_000)] : []),
    ],
  });
}

// Shared bounded catalogue refresh, never an inference-time model fallback.
export function createUsageCatalogue(
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  let cached: { body: z.infer<typeof catalogue>; fetchedAt: string; expires: number } | undefined;
  let pending: Promise<void> | undefined;
  async function refresh() {
    try {
      const response = await fetcher("https://models.dev/api.json", {
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!response.ok || !response.body) return;
      const limit = 12 * 1024 * 1024;
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > limit) throw new Error("Usage catalogue exceeded its bound");
          parts.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const parsed = catalogue.safeParse(body);
      if (!parsed.success) return;
      cached = {
        body: parsed.data,
        fetchedAt: new Date().toISOString(),
        expires: Date.now() + 86_400_000,
      };
    } catch {
      /* Unavailable price is unknown; never publish a fabricated free rate. */
    }
  }
  let nextAttempt = 0;
  function refreshIfDue() {
    if (pending) return pending;
    if ((cached && cached.expires >= Date.now()) || Date.now() < nextAttempt)
      return Promise.resolve();
    pending = refresh().finally(() => {
      pending = undefined;
      nextAttempt = Date.now() + 300_000;
    });
    return pending;
  }
  return {
    refresh: refreshIfDue,
    get(providerID: string, modelID: string) {
      void refreshIfDue();
      return cached && cached.expires >= Date.now()
        ? parsedRate(cached.body, providerID, modelID, cached.fetchedAt)
        : null;
    },
  };
}
export const usageCatalogue = createUsageCatalogue();
