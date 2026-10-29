import { expect, test } from "bun:test";
import { ownedPlanningCache, planningCacheDatabaseURL } from "../fixtures/planning-cache";

test("a cache on its owned PostgreSQL network uses container DNS, not a host-only published port", () => {
  const owner = crypto.randomUUID();
  const network = `factory-test-postgres-${owner}`;
  const database = `postgresql://factory:owned-test-password@127.0.0.1:32769/owned_${owner.replaceAll("-", "")}`;
  const target = new URL(planningCacheDatabaseURL(database, network));
  expect(target.hostname).toBe(network);
  expect(target.port).toBe("5432");
  expect(target.pathname).toBe(new URL(database).pathname);
  expect(target.username).toBe("factory");
  expect(target.password).toBe("owned-test-password");
  const hostTarget = new URL(planningCacheDatabaseURL(database));
  expect(hostTarget.hostname).toBe("host.docker.internal");
  expect(hostTarget.port).toBe("32769");
});

test("invalid sync worker counts fail before creating any planning-cache resource", async () => {
  for (const workers of [0, -1, 1.5, NaN, Infinity]) {
    await expect(
      ownedPlanningCache("not-a-database", "not-a-host", false, workers),
    ).rejects.toThrow("positive worker count");
  }
});
