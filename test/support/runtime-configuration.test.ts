import { expect, test } from "bun:test";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  ownedFactoryboxProfile,
  ownedRuntimeConfiguration,
} from "../fixtures/runtime-configuration";

test("owned runtime configuration selects the exact fresh worker profile", () => {
  expect(configuredFactoryboxRuntimeProfile(ownedRuntimeConfiguration)).toEqual(
    ownedFactoryboxProfile,
  );
});
