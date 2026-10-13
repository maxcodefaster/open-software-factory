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
});
