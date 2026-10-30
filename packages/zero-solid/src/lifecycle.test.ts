import { describe, expect, test } from "bun:test";
import type { ConnectionState } from "@rocicorp/zero";
import { ZeroClientLifecycle } from "./lifecycle";

function recoveringClient() {
  let state: ConnectionState = { name: "connected" };
  let connects = 0;
  let closed = 0;
  let sequence = 0;
  let behavior: (() => Promise<void>) | undefined;
  const listeners = new Set<(value: ConnectionState) => void>();
  const pending = new Map<number, { action(): void; delay: number }>();
  const emit = (next: ConnectionState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const client = {
    connection: {
      state: {
        get current() {
          return state;
        },
        subscribe(listener: (value: ConnectionState) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      async connect() {
        connects++;
        await behavior?.();
      },
    },
    async close() {
      closed++;
    },
  };
  const lifecycle = new ZeroClientLifecycle<typeof client>((action, delay) => {
    const id = ++sequence;
    pending.set(id, { action, delay });
    return () => pending.delete(id);
  });
  return {
    client,
    lifecycle,
    emit,
    connects: () => connects,
    closed: () => closed,
    pending: () => pending.size,
    listeners: () => listeners.size,
    behavior: (next: () => Promise<void>) => {
      behavior = next;
    },
    async tick() {
      const [id, next] = pending.entries().next().value ?? [];
      if (id === undefined || !next) throw new Error("No automatic reconnect was scheduled");
      pending.delete(id);
      next.action();
      await Bun.sleep(0);
      return next.delay;
    },
  };
}
const transportFailure: ConnectionState = {
  name: "error",
  reason: "Fetch from API server threw error: fetch failed",
};

describe("Zero client lifecycle", () => {
  test.each([
    transportFailure,
    { name: "error", reason: "Fetch from API server returned non-OK status 503" } as const,
  ])("reconnects the same cached client after a transient API failure: %s", async (failure) => {
    const owned = recoveringClient();
    const identity = { userId: "one", schemaVersion: "1" };
    try {
      const client = owned.lifecycle.select(identity, () => owned.client);
      owned.emit(failure);
      expect(owned.pending()).toBe(1);
      owned.behavior(async () => owned.emit({ name: "connected" }));
      expect(await owned.tick()).toBe(5_000);
      expect(owned.connects()).toBe(1);
      expect(owned.pending()).toBe(0);
      expect(owned.lifecycle.select(identity, () => owned.client)).toBe(client);
      expect(owned.closed()).toBe(0);
    } finally {
      owned.lifecycle.dispose();
    }
  });

  test("backs off repeated transport failures without concurrent reconnects and resets after recovery", async () => {
    const owned = recoveringClient();
    try {
      owned.lifecycle.select({ userId: "one", schemaVersion: "1" }, () => owned.client);
      owned.emit(transportFailure);
      owned.emit(transportFailure);
      expect(owned.pending()).toBe(1);
      for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000])
        expect(await owned.tick()).toBe(delay);
      expect(owned.connects()).toBe(5);
      owned.emit({ name: "connected" });
      expect(owned.pending()).toBe(0);
      owned.emit(transportFailure);
      expect(await owned.tick()).toBe(5_000);
    } finally {
      owned.lifecycle.dispose();
    }
  });

  test.each([
    { name: "needs-auth", reason: { type: "zero-cache", reason: "Access expired" } },
    { name: "error", reason: "Schema version is unsupported" },
    { name: "error", reason: "Fetch from API server returned non-OK status 403" },
    { name: "error", reason: "Failed to parse response from API server" },
    { name: "closed", reason: "Client was disposed" },
    { name: "disconnected", reason: "SDK owns its normal retry" },
  ] satisfies ConnectionState[])(
    "leaves non-transport recovery with its existing owner: %s",
    (state) => {
      const owned = recoveringClient();
      try {
        owned.lifecycle.select({ userId: "one", schemaVersion: "1" }, () => owned.client);
        owned.emit(transportFailure);
        owned.emit(state);
        expect(owned.pending()).toBe(0);
        expect(owned.connects()).toBe(0);
      } finally {
        owned.lifecycle.dispose();
      }
    },
  );

  test("identity changes cancel the original user's reconnect and state subscription", async () => {
    const first = recoveringClient();
    const second = recoveringClient();
    first.lifecycle.select({ userId: "one", schemaVersion: "1" }, () => first.client);
    first.emit(transportFailure);
    expect(first.pending()).toBe(1);
    first.lifecycle.select({ userId: "two", schemaVersion: "1" }, () => second.client);
    expect(first.pending()).toBe(0);
    expect(first.listeners()).toBe(0);
    expect(first.closed()).toBe(1);
    first.emit(transportFailure);
    expect(first.pending()).toBe(0);
    first.lifecycle.dispose();
    expect(second.listeners()).toBe(0);
  });

  test("disposal fences an in-flight reconnect's late completion", async () => {
    const owned = recoveringClient();
    const response = Promise.withResolvers<void>();
    owned.behavior(() => response.promise);
    owned.lifecycle.select({ userId: "one", schemaVersion: "1" }, () => owned.client);
    owned.emit(transportFailure);
    expect(await owned.tick()).toBe(5_000);
    owned.lifecycle.dispose();
    response.resolve();
    await Bun.sleep(0);
    expect(owned.pending()).toBe(0);
    expect(owned.listeners()).toBe(0);
    expect(owned.connects()).toBe(1);
  });

  test("disposal cancels a queued retry before it reaches the old connection", async () => {
    const owned = recoveringClient();
    owned.lifecycle.select({ userId: "one", schemaVersion: "1" }, () => owned.client);
    owned.emit(transportFailure);
    const ticking = owned.tick();
    owned.lifecycle.dispose();
    await ticking;
    expect(owned.connects()).toBe(0);
    expect(owned.pending()).toBe(0);
  });

  test("an unconfirmed reconnect cannot dispatch another request or retry expired authority", async () => {
    const owned = recoveringClient();
    const response = Promise.withResolvers<void>();
    owned.behavior(() => response.promise);
    try {
      owned.lifecycle.select({ userId: "one", schemaVersion: "1" }, () => owned.client);
      owned.emit(transportFailure);
      await owned.tick();
      owned.emit(transportFailure);
      expect(owned.pending()).toBe(0);
      expect(owned.connects()).toBe(1);
      owned.emit({ name: "needs-auth", reason: { type: "zero-cache", reason: "Revoked" } });
      response.resolve();
      await Bun.sleep(0);
      expect(owned.pending()).toBe(0);
      expect(owned.connects()).toBe(1);
    } finally {
      response.resolve();
      owned.lifecycle.dispose();
    }
  });

  test("reuses one user/schema client and closes it on identity change", async () => {
    let closed = 0;
    const lifecycle = new ZeroClientLifecycle<{
      connection: {
        state: { current: { name: "connected" }; subscribe(): () => void };
        connect(): Promise<void>;
      };
      close(): Promise<void>;
    }>();
    const create = () => ({
      connection: {
        state: { current: { name: "connected" } as const, subscribe: () => () => {} },
        async connect() {},
      },
      async close() {
        closed += 1;
      },
    });
    const first = lifecycle.select({ userId: "one", schemaVersion: "1" }, create);
    expect(lifecycle.select({ userId: "one", schemaVersion: "1" }, create)).toBe(first);
    lifecycle.select({ userId: "two", schemaVersion: "1" }, create);
    await Bun.sleep(0);
    expect(closed).toBe(1);
    lifecycle.dispose();
  });

  test("refreshes a changed auth token without discarding the user's cache", async () => {
    const tokens: string[] = [];
    let closed = 0;
    const client = {
      connection: {
        state: { current: { name: "connected" } as const, subscribe: () => () => {} },
        async connect(options?: { auth: string }) {
          if (options) tokens.push(options.auth);
        },
      },
      async close() {
        closed++;
      },
    };
    const lifecycle = new ZeroClientLifecycle<typeof client>();
    lifecycle.select({ userId: "one", schemaVersion: "1", auth: "first" }, () => client);
    expect(
      lifecycle.select({ userId: "one", schemaVersion: "1", auth: "second" }, () => client),
    ).toBe(client);
    expect(tokens).toEqual(["second"]);
    expect(closed).toBe(0);
    lifecycle.dispose();
    await Bun.sleep(0);
    expect(closed).toBe(1);
  });
});
