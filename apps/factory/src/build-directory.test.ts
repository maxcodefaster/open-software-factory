import { expect, test } from "bun:test";
import { factoryBuildDirectory } from "./build-directory";

test("Factory build roots keep the packaged default and explicit owned artifacts separate", () => {
  expect(factoryBuildDirectory("")).toBe(new URL("../dist", import.meta.url).pathname);
  expect(factoryBuildDirectory("/owned/proof/build")).toBe("/owned/proof/build");
  expect(factoryBuildDirectory("/owned/proof/build")).not.toBe(factoryBuildDirectory(""));
});
