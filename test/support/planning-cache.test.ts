import { expect, test } from "bun:test";
import { ownedPlanningCache } from "../fixtures/planning-cache";

test("invalid sync worker counts fail before creating any planning-cache resource", async () => {
  for (const workers of [0, -1, 1.5, NaN, Infinity]) {
    await expect(
      ownedPlanningCache("not-a-database", "not-a-host", false, workers),
    ).rejects.toThrow("positive worker count");
  }
});
