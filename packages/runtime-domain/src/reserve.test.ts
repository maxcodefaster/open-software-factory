import { expect, test } from "bun:test";
import {
  defaultReservePolicy,
  requireReservePolicy,
  reserveCreationCount,
  reserveIdentity,
} from "./reserve";

test("reserve counts admitted creation, expiry cleanup and assigned execution against hard limits", () => {
  const counts = { matching: 0, creating: 0, spare: 0, execution: 7 };
  expect(reserveCreationCount(defaultReservePolicy, counts)).toBe(1);
  expect(reserveCreationCount(defaultReservePolicy, { ...counts, creating: 1, spare: 1 })).toBe(0);
  expect(reserveCreationCount(defaultReservePolicy, { ...counts, matching: 1, spare: 1 })).toBe(0);
  expect(reserveCreationCount(defaultReservePolicy, { ...counts, spare: 2 })).toBe(0);
  expect(reserveCreationCount(defaultReservePolicy, { ...counts, execution: 16 })).toBe(0);
  expect(reserveCreationCount(defaultReservePolicy, { ...counts, spare: 1, execution: 15 })).toBe(
    0,
  );
});

test("reserve policy cannot exceed bounded targets or create invalid resource identities", () => {
  expect(requireReservePolicy(defaultReservePolicy)).toEqual(defaultReservePolicy);
  for (const override of [
    { readyPerRole: 5 },
    { maxSlots: 1 },
    { creationConcurrency: 3 },
    { maxExecutionSlots: 1 },
    { expiryMS: 0 },
  ])
    expect(() => requireReservePolicy({ ...defaultReservePolicy, ...override })).toThrow(
      "bounded limits",
    );
  expect(reserveIdentity("ec253fc1-4e17-4a75-a36d-c4efef02e77e")).toEqual({
    id: "ec253fc1-4e17-4a75-a36d-c4efef02e77e",
    namespace: "factory-reserve-ec253fc14e17",
    podName: "slot",
  });
  expect(() => reserveIdentity("../another-owner")).toThrow("identity");
});
