import { expect, test } from "bun:test";
import {
  factoryboxKernelMatches,
  factoryboxKernelPolicy,
  factoryboxKernelRestriction,
  validFactoryboxKernelPolicy,
} from "./factorybox-kernel";
import { configuredFactoryboxRuntimeProfile } from "./factorybox-runtime";

test("an exact release matches only itself", () => {
  expect(factoryboxKernelMatches("6.12.4-1", "6.12.4-1")).toBe(true);
  expect(factoryboxKernelMatches("6.12.4-1", "6.12.4-12")).toBe(false);
  expect(factoryboxKernelMatches("5.15.0-1.azure", "5.15.0-1xazure")).toBe(false);
});

test("wildcards and lists cover a managed node's upgraded kernels", () => {
  const policy = "5.15.0-*-azure, 6.*.0-*-azure";
  for (const release of ["5.15.0-1068-azure", "6.8.0-1015-azure", "6.11.0-1-azure"])
    expect(factoryboxKernelMatches(policy, release)).toBe(true);
  for (const release of ["5.15.0-1068-generic", "5.4.0-1-azure", "x5.15.0-1-azure", ""])
    expect(factoryboxKernelMatches(policy, release)).toBe(false);
});

test("an unset, empty or * kernel admits any release", () => {
  for (const policy of [undefined, "", " ", "*", " * "])
    for (const release of ["5.15.0-1068-azure", "6.12.4-1", "7.0.0-custom"]) {
      expect(factoryboxKernelMatches(policy, release)).toBe(true);
      expect(factoryboxKernelRestriction(policy)).toBeUndefined();
    }
  expect(factoryboxKernelRestriction(" 6.8.0-*-azure ")).toBe("6.8.0-*-azure");
  expect(factoryboxKernelPolicy.safeParse(undefined).success).toBe(true);
  expect(factoryboxKernelPolicy.safeParse("*").success).toBe(true);
});

test("a restriction cannot smuggle regular-expression syntax or hide a bare wildcard", () => {
  for (const invalid of [
    "**,5.15.*",
    "*,6.8.0",
    "5.15|6.*",
    "5.15.(0)",
    "5 15",
    `${"6.1,".repeat(20)}6`,
  ])
    expect(validFactoryboxKernelPolicy(invalid)).toBe(false);
  expect(factoryboxKernelMatches("5.15|6.*", "5.15")).toBe(false);
  expect(factoryboxKernelPolicy.safeParse("6.8.0-*-azure").success).toBe(true);
  expect(factoryboxKernelPolicy.safeParse("a".repeat(257)).success).toBe(false);
});

test("the installation profile accepts an absent, empty or * kernel and keeps a restriction", () => {
  const environment = {
    FACTORY_FACTORYBOX_WORKER_IMAGE: `registry.invalid/factorybox@sha256:${"a".repeat(64)}`,
    FACTORY_FACTORYBOX_EXECUTABLE_SHA256: "b".repeat(64),
    FACTORY_FACTORYBOX_ARCHITECTURE: "amd64",
    FACTORY_FACTORYBOX_NODE: "node-1",
  };
  expect(configuredFactoryboxRuntimeProfile(environment).kernel).toBeUndefined();
  for (const kernel of ["", "*"])
    expect(
      factoryboxKernelRestriction(
        configuredFactoryboxRuntimeProfile({ ...environment, FACTORY_FACTORYBOX_KERNEL: kernel })
          .kernel,
      ),
    ).toBeUndefined();
  expect(
    configuredFactoryboxRuntimeProfile({
      ...environment,
      FACTORY_FACTORYBOX_KERNEL: "6.8.0-*-azure",
    }).kernel,
  ).toBe("6.8.0-*-azure");
});
