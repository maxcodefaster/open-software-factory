import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMonitoringRoutes } from "./routes";
import type { createMonitoringController } from "./controller";

test("Inputs retain both external webhook URLs but no HTTP settings API or browser intake", async () => {
  const id = crypto.randomUUID(),
    key = "a".repeat(43);
  const received: unknown[][] = [];
  const routes = createMonitoringRoutes({
    authenticate: async (hook: string, secret: string) => hook === id && secret === key,
    async receive(...args: unknown[]) {
      received.push(args);
      return { limited: false, accepted: 1, duplicates: 0, ignored: 0 };
    },
  } as unknown as ReturnType<typeof createMonitoringController>);
  expect(routes).not.toHaveProperty("settings");
  const body = JSON.stringify({ title: "Owned external request", id: "owned-request" });
  for (const kind of ["inputs", "monitoring"]) {
    const response = await routes.intake(
      new Request(`https://factory.test/hooks/${kind}/${id}/${key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response?.status).toBe(202);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  }
  expect(received).toHaveLength(2);
  expect(received[0]?.slice(0, 3)).toEqual([
    id,
    key,
    createHash("sha256").update(body).digest("hex"),
  ]);
  expect(
    (
      await routes.intake(
        new Request(`https://factory.test/hooks/inputs/${id}/${key}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://factory.test" },
          body,
        }),
      )
    )?.status,
  ).toBe(404);
  expect(received).toHaveLength(2);
  expect(
    await routes.intake(new Request(`https://factory.test/api/projects/${id}/inputs`)),
  ).toBeUndefined();
});
