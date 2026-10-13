import { expect, test } from "bun:test";
import { dependencyWouldCycle, prerequisiteIsDelivered, ticketDependencyInput } from "./dependency";

test("dependency inputs reject self references, stale versions and unknown fields", () => {
  const input = {
    projectId: crypto.randomUUID(),
    ticketId: crypto.randomUUID(),
    prerequisiteId: crypto.randomUUID(),
    expectedVersion: 1,
  };
  expect(ticketDependencyInput.parse(input)).toEqual(input);
  expect(() => ticketDependencyInput.parse({ ...input, prerequisiteId: input.ticketId })).toThrow();
  expect(() => ticketDependencyInput.parse({ ...input, expectedVersion: 0 })).toThrow();
  expect(() => ticketDependencyInput.parse({ ...input, delivered: true })).toThrow();
});

test("the read projection requires Delivery, successful Verification, merge and promotion", () => {
  const delivered = {
    ticketState: "done",
    changeState: "delivered",
    verificationState: "succeeded",
    mergeState: "succeeded",
    promotionState: "succeeded",
  };
  expect(prerequisiteIsDelivered(delivered)).toBe(true);
  expect(prerequisiteIsDelivered({ ticketState: "done" })).toBe(false);
  for (const field of Object.keys(delivered)) {
    expect(prerequisiteIsDelivered({ ...delivered, [field]: "cancelled" })).toBe(false);
    expect(prerequisiteIsDelivered({ ...delivered, [field]: undefined })).toBe(false);
  }
});

test("directed prerequisites reject transitive cycles but allow shared prerequisites", () => {
  const dependencies = [
    { ticketId: "a", prerequisiteId: "b" },
    { ticketId: "b", prerequisiteId: "c" },
    { ticketId: "a", prerequisiteId: "d" },
  ];
  expect(dependencyWouldCycle(dependencies, "c", "a")).toBe(true);
  expect(dependencyWouldCycle(dependencies, "b", "a")).toBe(true);
  expect(dependencyWouldCycle(dependencies, "a", "a")).toBe(true);
  expect(dependencyWouldCycle(dependencies, "d", "c")).toBe(false);
  expect(dependencyWouldCycle(dependencies, "e", "a")).toBe(false);
  expect(
    dependencyWouldCycle([...dependencies, { ticketId: "c", prerequisiteId: "b" }], "e", "a"),
  ).toBe(false);
});
