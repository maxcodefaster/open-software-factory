import { expect, test } from "bun:test";
import {
  factoryboxKernelMatches,
  factoryboxKernelPolicy,
  validFactoryboxKernelPolicy,
} from "./factorybox-kernel";

test("an exact release matches only itself", () => {
  expect(factoryboxKernelMatches("7.2.8-9-omarchy", "7.2.8-9-omarchy")).toBe(true);
  expect(factoryboxKernelMatches("7.2.8-9-omarchy", "7.2.8-9-omarchy2")).toBe(false);
  expect(factoryboxKernelMatches("5.15.0-1.azure", "5.15.0-1xazure")).toBe(false);
});

test("wildcards and lists cover a managed node's upgraded kernels", () => {
  const policy = "5.15.0-*-azure, 6.*.0-*-azure";
  for (const release of ["5.15.0-1068-azure", "6.8.0-1015-azure", "6.11.0-1-azure"])
    expect(factoryboxKernelMatches(policy, release)).toBe(true);
  for (const release of ["5.15.0-1068-generic", "5.4.0-1-azure", "x5.15.0-1-azure", ""])
    expect(factoryboxKernelMatches(policy, release)).toBe(false);
});

test("a policy cannot disable the kernel gate or smuggle regular-expression syntax", () => {
  for (const invalid of [
    "*",
    "**,5.15.*",
    "",
    "5.15|6.*",
    "5.15.(0)",
    "5 15",
    `${"6.1,".repeat(20)}6`,
  ])
    expect(validFactoryboxKernelPolicy(invalid)).toBe(false);
  expect(factoryboxKernelMatches("*", "5.15.0")).toBe(false);
  expect(factoryboxKernelPolicy.safeParse("6.8.0-*-azure").success).toBe(true);
  expect(factoryboxKernelPolicy.safeParse("a".repeat(257)).success).toBe(false);
});
