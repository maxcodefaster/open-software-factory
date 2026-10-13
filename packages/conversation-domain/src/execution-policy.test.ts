import { test, expect } from "bun:test";
import {
  defaultExecutionPolicy,
  codingDecision,
  effectiveExecutionPolicy,
  tighterExecutionPolicy,
  executionPolicyCommand,
} from "./execution-policy";
test("unlimited defaults tolerate unknown costs; enabled budgets distinguish starts and finish reserve", () => {
  const policy = defaultExecutionPolicy();
  const decision = (spent: bigint, continuation = false, unknown = false) =>
    codingDecision({ policy, knownNanoUSD: spent, continuation, unknown });
  expect(decision(1000n, false, true).allowed).toBe(true);
  policy.codingUSD = 1;
  expect(decision(800000000n).warning).toBe(true);
  expect(decision(1000000000n).reason).toBe("coding-budget-used");
  expect(decision(1000000000n, true).allowed).toBe(true);
  expect(decision(1100000000n, true).reason).toBe("finish-reserve-used");
  expect(decision(0n, false, true).reason).toBe("accounting-incomplete");
});
test("Project restrictions can only tighten and timezone is validated", () => {
  const factory = { ...defaultExecutionPolicy(), codingUSD: 100, cpuMilli: 2000 };
  const project = { ...defaultExecutionPolicy(), codingUSD: 50, cpuMilli: 1000 };
  expect(tighterExecutionPolicy(factory, project)).toBe(true);
  expect(tighterExecutionPolicy(factory, { ...project, codingUSD: 200 })).toBe(false);
  expect(effectiveExecutionPolicy(factory, null)).toEqual(factory);
  expect(
    executionPolicyCommand.safeParse({
      commandID: crypto.randomUUID(),
      version: 0,
      policy: {},
      timezone: "invalid",
    }).success,
  ).toBe(false);
});
