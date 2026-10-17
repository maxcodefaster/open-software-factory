import { expect, test } from "bun:test";
import { catalogueRate, createUsageCatalogue } from "./rates";

const body = {
  owned: {
    models: {
      exact: {
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.2,
          context_over_200k: { input: 4, output: 15 },
        },
      },
    },
  },
};
test("catalogue selects only exact model and preserves missing price fields", () => {
  expect(catalogueRate(body, "owned", "exact", "2026-10-11T00:00:00Z")?.tiers).toHaveLength(2);
  expect(
    catalogueRate(body, "owned", "exact", "2026-10-11T00:00:00Z")?.tiers[0]?.cacheWrite,
  ).toBeNull();
  expect(catalogueRate(body, "owned", "missing", "2026-10-11T00:00:00Z")).toBeNull();
  expect(catalogueRate({}, "owned", "exact", "2026-10-11T00:00:00Z")).toBeNull();
});
test("catalogue refresh is shared and request reads never wait for the network", async () => {
  let calls = 0;
  const cached = createUsageCatalogue(async () => {
    calls++;
    return Response.json(body);
  });
  await cached.refresh();
  const rates = await Promise.all(Array.from({ length: 8 }, () => cached.get("owned", "exact")));
  expect(calls).toBe(1);
  expect(rates.every((rate) => rate?.model === "exact")).toBe(true);
  const unavailable = createUsageCatalogue(async () => {
    calls++;
    return new Response(null, { status: 503 });
  });
  expect(await unavailable.get("owned", "exact")).toBeNull();
  expect(await unavailable.get("owned", "exact")).toBeNull();
  expect(calls).toBe(2);
});

test("an offline price catalogue cannot delay first inference or a budget transaction", async () => {
  const release = Promise.withResolvers<Response>();
  let calls = 0;
  const cached = createUsageCatalogue(() => {
    calls++;
    return release.promise;
  });
  try {
    const answer = await Promise.race([
      Promise.resolve(cached.get("owned", "exact")),
      Bun.sleep(50).then(() => {
        throw new Error("Price lookup delayed inference");
      }),
    ]);
    expect(answer).toBeNull();
    expect(calls).toBe(1);
    release.resolve(Response.json(body));
    await cached.refresh();
    expect(cached.get("owned", "exact")?.tiers[0]?.input).toBe(2);
  } finally {
    release.resolve(new Response(null, { status: 503 }));
  }
});
