import { z } from "zod";
import { usageRate, type UsageRate } from "../../../../packages/conversation-domain/src/usage";

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
  const selected = parsed.data[providerID]?.models[modelID]?.cost;
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
  let cached: { body: unknown; fetchedAt: string; expires: number } | undefined;
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
      if (!catalogue.safeParse(body).success) return;
      cached = { body, fetchedAt: new Date().toISOString(), expires: Date.now() + 86_400_000 };
    } catch {
      /* Unavailable price is unknown; never publish a fabricated free rate. */
    }
  }
  let nextAttempt = 0;
  return {
    async get(providerID: string, modelID: string) {
      if ((!cached || cached.expires < Date.now()) && Date.now() >= nextAttempt) {
        pending ??= refresh().finally(() => {
          pending = undefined;
          nextAttempt = Date.now() + 300_000;
        });
        await pending;
      }
      return cached && cached.expires >= Date.now()
        ? catalogueRate(cached.body, providerID, modelID, cached.fetchedAt)
        : null;
    },
  };
}
export const usageCatalogue = createUsageCatalogue();
