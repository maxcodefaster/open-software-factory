import { expect, test } from "bun:test";
import { createUsageJournal } from "../../apps/factory/src/usage/journal";
import { factoryProcess } from "../fixtures/factory-process";

test("usage journal serializes replay, freezes attribution/rates and retains twelve calendar months", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const journal = createUsageJournal(database);
  const operation = {
    id: "owned:usage",
    projectID: null,
    userID: null,
    purpose: "probe" as const,
    engine: "mastra" as const,
    provider: "owned",
    model: "exact",
    rate: {
      provider: "owned",
      model: "exact",
      source: "contract" as const,
      fetchedAt: "2026-10-11T00:00:00.000Z",
      tiers: [{ above: 0, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    },
  };
  const observation = {
    eventID: "step:1",
    source: "step" as const,
    outcome: "completed" as const,
    counters: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, reasoning: 40 },
    occurredAt: "2026-10-11T12:00:00.000Z",
  };
  try {
    await journal.begin(operation);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        journal.record(operation.id, observation, { sessionID: "session", sequence: 10 }),
      ),
    );
    const [total] =
      await database.client`SELECT count(*)::integer AS count,sum(nano_usd)::text AS cost FROM factory.usage_entry`;
    expect(total).toEqual({ count: 1, cost: "729000" });
    expect(await journal.cursor(operation.id, "session")).toBe(10);
    await journal.record(operation.id, observation, { sessionID: "session", sequence: 2 });
    expect(await journal.cursor(operation.id, "session")).toBe(10);
    await expect(
      journal.record(operation.id, {
        ...observation,
        counters: { ...observation.counters, input: 1 },
      }),
    ).rejects.toThrow("changed observation");
    await expect(journal.begin({ ...operation, purpose: "coding" })).rejects.toThrow(
      "changed attribution",
    );
    await journal.begin({
      ...operation,
      rate: { ...operation.rate, tiers: [{ ...operation.rate.tiers[0]!, input: 99 }] },
    });
    await journal.record(operation.id, { ...observation, eventID: "step:2" });
    const [second] = await database.client<
      Array<{ cost: string }>
    >`SELECT nano_usd::text AS cost FROM factory.usage_entry WHERE event_id='step:2'`;
    expect(second?.cost).toBe("729000");
    await expect(
      (async () => {
        await database.client`UPDATE factory.usage_operation SET model='other' WHERE id=${operation.id}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      (async () => {
        await database.client`UPDATE factory.usage_entry SET nano_usd=0 WHERE operation_id=${operation.id}`;
      })(),
    ).rejects.toThrow("immutable");
    await journal.settle(operation.id, "completed");
    await journal.settle(operation.id, "failed");
    const [created] = await database.client<{ created_at: Date }[]>`
      SELECT created_at FROM factory.usage_operation WHERE id=${operation.id}`;
    const anniversary = new Date(created!.created_at);
    anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
    const pruneBefore = new Date(anniversary.getTime() - 1);
    const pruneAfter = new Date(anniversary.getTime() + 1000);
    expect(await journal.prune(pruneBefore)).toHaveLength(0);
    expect(await journal.prune(pruneAfter)).toHaveLength(1);
    expect(await journal.cursor(operation.id, "session")).toBe(0);
    await journal.begin({ ...operation, id: "owned:long-lived" });
    await journal.record("owned:long-lived", observation);
    const recent = new Date(pruneAfter);
    recent.setUTCMonth(recent.getUTCMonth() - 1);
    await journal.record("owned:long-lived", {
      ...observation,
      eventID: "recent",
      occurredAt: recent.toISOString(),
    });
    await journal.settle("owned:long-lived", "completed");
    expect(await journal.prune(pruneAfter)).toHaveLength(0);
    expect(
      [...await database.client`SELECT event_id FROM factory.usage_entry WHERE operation_id='owned:long-lived'`],
    ).toEqual([{ event_id: "recent" }]);
    await journal.abandon("owned:long-lived");
    await expect(journal.record("unadmitted", observation)).rejects.toThrow(
      "admitted before observation",
    );
    expect(JSON.stringify(await database.client`SELECT * FROM factory.usage_entry`)).not.toContain(
      "prompt",
    );
  } finally {
    await database.client.end({ timeout: 2 });
    await fixture.dispose();
  }
}, 60_000);
