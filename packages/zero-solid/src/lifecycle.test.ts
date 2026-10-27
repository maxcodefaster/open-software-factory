import { describe, expect, test } from "bun:test";
import { ZeroClientLifecycle } from "./lifecycle";

describe("Zero client lifecycle", () => {
  test("reuses one user/schema client and closes it on identity change", async () => {
    let closed = 0;
    const lifecycle = new ZeroClientLifecycle<{
      connection: { state: { current: { name: "connected" } } };
      close(): Promise<void>;
    }>();
    const create = () => ({
      connection: { state: { current: { name: "connected" } as const } },
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
        state: { current: { name: "connected" } as const },
        async connect(options: { auth: string }) {
          tokens.push(options.auth);
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
